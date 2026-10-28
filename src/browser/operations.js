import { nowIso } from '../db/index.js';
import { badRequest, conflict, HttpError } from '../lib/errors.js';
import { CAMPAIGN_KEYS, periodRange, summarizeAdAccount } from '../lib/tiktok-model.js';
import { InteractiveSession } from './interactive.js';
import { LoginFlow } from './login-flow.js';
import { listAccountsInPage, listCampaignsInPage } from './page-scripts.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LOGIN_PATH = /\/(login|signin|sso)(\/|$)/i;
const firstLine = (e) => String(e?.message ?? e).split('\n')[0].slice(0, 220);

class FlowError extends Error {
  constructor(kind, message) { super(message); this.kind = kind; }
}

const AUTH_MESSAGE = 'Сессия истекла или недействительна — войдите заново или вставьте новые cookies.';

/**
 * Orchestrates every browser job: login, session check, sync, assist browser.
 * `runtime` (Map accountId -> { busy, waitingFor }) is shared with AccountService for DTOs.
 */
export class Operations {
  constructor({ config, pool, accounts, adAccounts, events, runtime }) {
    Object.assign(this, { config, pool, accounts, adAccounts, events, runtime });
    this.sessions = new Map();
    this.flows = new Map();
    this.sweeper = setInterval(() => this.#sweep(), 30_000);
    this.sweeper.unref();
    this.allowedHosts = [new URL(config.tiktok.origin).hostname];
  }

  // ---- helpers -----------------------------------------------------------------------------------------------

  #rt(id) {
    let r = this.runtime.get(id);
    if (!r) { r = { busy: null, waitingFor: null }; this.runtime.set(id, r); }
    return r;
  }

  #begin(id, busy) {
    const rt = this.runtime.get(id);
    if (rt?.busy) throw conflict('С этим аккаунтом уже выполняется операция — дождитесь её завершения или отмените.', 'busy');
    this.#rt(id).busy = busy;
  }

  #end(id) { this.runtime.delete(id); }

  #log(id, level, kind, message, user = '') {
    const row = this.accounts.getRow(id);
    this.events.add({ level, kind, accountId: id, accountLabel: row ? row.label || row.login : '', user, message });
  }

  isBusy(id) { return !!this.runtime.get(id)?.busy; }

  stats() {
    const rt = [...this.runtime.values()];
    return {
      running: rt.filter((r) => r.busy).length,
      browser: {
        ready: this.pool.available, headless: this.config.browser.headless,
        interactive: { active: this.pool.interactive.active, max: this.pool.interactive.max },
        background: { active: this.pool.background.active, max: this.pool.background.max, queued: this.pool.background.queued }
      }
    };
  }

  recoverStatuses() {
    const rows = this.accounts.db.prepare("SELECT id, session_enc, status FROM accounts WHERE status IN ('logging_in','need_code','need_manual','checking')").all();
    for (const r of rows) {
      if (r.status === 'checking') this.accounts.setStatus(r.id, r.session_enc ? 'active' : 'new', 'Проверка прервана перезапуском сервера.');
      else this.accounts.setStatus(r.id, r.session_enc ? 'session_expired' : 'new', 'Вход прерван перезапуском сервера.');
    }
    return rows.length;
  }

  // ---- shared page helpers -----------------------------------------------------------------------------------

  async #settle(page) {
    await page.waitForLoadState('networkidle', { timeout: 12_000 }).catch(() => {});
    await sleep(1200);
  }

  // Opens the Ads Manager home and reads the account list from inside the page (the extension's "session API").
  async #verifyInPage(page) {
    const { tiktok, browser } = this.config;
    try {
      await page.goto(tiktok.homeUrl, { waitUntil: 'domcontentloaded', timeout: browser.pageTimeoutMs });
    } catch (e) {
      return { ok: false, kind: 'network', message: `Не удалось открыть TikTok Ads (сеть/прокси): ${firstLine(e)}` };
    }
    await this.#settle(page);
    if (LOGIN_PATH.test(new URL(page.url()).pathname)) {
      return { ok: false, kind: 'auth', message: 'TikTok перенаправил на страницу входа: сессия не принята с этого IP (частая причина — риск-контроль без резидентного прокси; сам магазин это предупреждает) либо действительно истекла. Попробуйте с прокси или вставьте свежие cookies.' };
    }
    let result = await page.evaluate(listAccountsInPage, { origin: tiktok.origin, expected: '' });
    if (!result.ok && result.kind === 'network') {
      await sleep(2500);
      result = await page.evaluate(listAccountsInPage, { origin: tiktok.origin, expected: '' });
    }
    return result;
  }

  async #withSession(id, fn) {
    const state = this.accounts.loadSession(id);
    if (!state?.cookies?.length) throw new FlowError('no_session', 'Нет сохранённой сессии — войдите по паролю или вставьте cookies.');
    const creds = this.accounts.credentials(id);
    const context = await this.pool.newContext({ storageState: state, proxyUrl: creds.proxy, locale: creds.locale, timezone: creds.timezone, viewport: creds.viewport, userAgent: creds.userAgent });
    try {
      const page = await context.newPage();
      return await fn({ context, page });
    } finally {
      await context.close().catch(() => {});
    }
  }

  #failStatus(id, error, user) {
    const kind = error instanceof FlowError || error?.kind ? error.kind : 'error';
    const message = firstLine(error);
    if (kind === 'auth') {
      this.accounts.setStatus(id, 'session_expired', message, { lastCheckAt: nowIso(), lastError: message });
      this.#log(id, 'warn', 'session.expired', message, user);
    } else if (kind === 'blocked') {
      this.accounts.setStatus(id, 'error', message, { lastCheckAt: nowIso(), lastError: message });
      this.#log(id, 'warn', 'session.blocked', message, user);
    } else if (kind === 'no_session') {
      this.accounts.setStatus(id, 'new', message, { lastError: message });
      this.#log(id, 'warn', 'session.missing', message, user);
    } else {
      this.accounts.setStatus(id, 'error', message, { lastCheckAt: nowIso(), lastError: message });
      this.#log(id, 'error', 'operation.failed', message, user);
    }
  }

  // ---- session check & sync ----------------------------------------------------------------------------------

  startCheck(id, user = '') {
    const row = this.accounts.requireRow(id);
    if (row.disabled) throw conflict('Аккаунт отключён.');
    if (!row.session_enc) throw badRequest('Нет сохранённой сессии: сначала войдите или вставьте cookies.');
    this.#begin(id, 'check');
    this.accounts.setStatus(id, 'checking', 'Проверяю сессию…');
    this.#runCheck(id, user).catch(() => {});
    return this.accounts.get(id);
  }

  async #runCheck(id, user) {
    let acquired = false;
    try {
      await this.pool.background.acquire();
      acquired = true;
      const result = await this.#withSession(id, async ({ context, page }) => {
        const listing = await this.#verifyInPage(page);
        if (listing.ok) this.accounts.saveSession(id, await context.storageState());
        return listing;
      });
      if (!result.ok) throw Object.assign(new Error(result.message), { kind: result.kind });
      const note = result.noAdsAccess ? (result.message || '') : '';
      this.accounts.setStatus(id, 'active', note, { lastCheckAt: nowIso(), lastError: '', adAccountsCount: result.accounts.length, bcCount: result.businessCenters.length });
      this.#log(id, result.noAdsAccess ? 'warn' : 'info', 'session.ok', result.noAdsAccess ? 'Сессия активна, но у логина нет рекламных кабинетов (нет доступа к Ads Manager).' : `Сессия активна. Кабинетов: ${result.accounts.length}.`, user);
    } catch (e) {
      this.#failStatus(id, e, user);
    } finally {
      if (acquired) this.pool.background.release();
      this.#end(id);
    }
  }

  startSync(id, user = '') {
    const row = this.accounts.requireRow(id);
    if (row.disabled) throw conflict('Аккаунт отключён.');
    if (!row.session_enc) throw badRequest('Нет сохранённой сессии: сначала войдите или вставьте cookies.');
    this.#begin(id, 'sync');
    this.#runSync(id, user).catch(() => {});
    return this.accounts.get(id);
  }

  async #runSync(id, user) {
    const { tiktok } = this.config;
    let acquired = false;
    try {
      await this.pool.background.acquire();
      acquired = true;
      const range = periodRange('7d');
      const outcome = await this.#withSession(id, async ({ context, page }) => {
        const listing = await this.#verifyInPage(page);
        if (!listing.ok) return { listing };
        const targets = listing.accounts.slice(0, tiktok.maxAdAccountsPerSync);
        const data = targets.length
          ? await page.evaluate(listCampaignsInPage, { origin: tiktok.origin, st: range.st, et: range.et, ids: targets.map((a) => a.id), keys: CAMPAIGN_KEYS, pageSize: 200, maxRows: 200, concurrency: 3 })
          : { ok: true, results: [] };
        this.accounts.saveSession(id, await context.storageState());
        return { listing, data };
      });
      const { listing, data } = outcome;
      if (!listing.ok) throw Object.assign(new Error(listing.message), { kind: listing.kind });
      if (!data.ok) throw Object.assign(new Error(data.message), { kind: data.kind });
      if (data.results.length && data.results.every((r) => r.error && r.kind === 'auth')) throw Object.assign(new Error(AUTH_MESSAGE), { kind: 'auth' });

      const summaries = new Map(data.results.map((r) => [r.id, summarizeAdAccount(r.error ? { error: r.error } : r)]));
      const saved = this.adAccounts.saveSync(id, { businessCenters: listing.businessCenters, list: listing.accounts, summaries, period: range });
      const failed = [...summaries.values()].filter((s) => s.state === 'error').length;
      const note = listing.noAdsAccess ? (listing.message || '') : failed ? `Часть кабинетов не прочиталась: ${failed}.` : '';
      this.accounts.setStatus(id, 'active', note, {
        lastSyncAt: nowIso(), lastCheckAt: nowIso(), lastError: '', adAccountsCount: saved.adAccounts, bcCount: saved.businessCenters
      });
      this.#log(id, failed || listing.noAdsAccess ? 'warn' : 'info', 'sync.done', listing.noAdsAccess ? 'Синхронизация: у логина нет рекламных кабинетов (нет доступа к Ads Manager).' : `Синхронизация: кабинетов ${saved.adAccounts}, BC ${saved.businessCenters}${failed ? `, с ошибкой ${failed}` : ''}.`, user);
    } catch (e) {
      this.#failStatus(id, e, user);
    } finally {
      if (acquired) this.pool.background.release();
      this.#end(id);
    }
  }

  // ---- login -------------------------------------------------------------------------------------------------

  startLogin(id, user = '') {
    const row = this.accounts.requireRow(id);
    if (row.disabled) throw conflict('Аккаунт отключён.');
    if (!row.password_enc || !row.login) throw badRequest('Для входа по паролю нужны логин и пароль. Для входа по сессии вставьте cookies.');
    if (!this.pool.interactive.tryAcquire()) throw conflict('Все слоты браузера заняты — закройте другие входы или браузеры.', 'no_slot');
    try { this.#begin(id, 'login'); } catch (e) { this.pool.interactive.release(); throw e; }
    this.accounts.setStatus(id, 'logging_in', 'Запускаю браузер…', { lastError: '' });
    this.#log(id, 'info', 'login.start', 'Запущен вход по логину и паролю.', user);
    this.#runLogin(id, user).catch(() => {});
    return this.accounts.get(id);
  }

  async #runLogin(id, user) {
    let session = null;
    let success = false;
    try {
      const creds = this.accounts.credentials(id);
      const context = await this.pool.newContext({ proxyUrl: creds.proxy, locale: creds.locale, timezone: creds.timezone, viewport: creds.viewport, userAgent: creds.userAgent });
      const page = await context.newPage();
      session = new InteractiveSession({ kind: 'login', accountId: id, context, page, allowedHosts: this.allowedHosts });
      this.sessions.set(id, session);
      const flow = new LoginFlow({
        session, creds, config: this.config,
        onState: (status, message) => {
          this.accounts.setStatus(id, status, message);
          const rt = this.#rt(id);
          rt.waitingFor = status === 'need_code' ? 'code' : status === 'need_manual' ? 'manual' : null;
        },
        log: (level, kind, message) => this.#log(id, level, kind, message, user),
        verify: () => this.#verifyInPage(session.page)
      });
      this.flows.set(id, flow);
      const result = await flow.run();
      if (result.outcome === 'success') {
        const state = await session.storageState();
        if (!this.accounts.saveSession(id, state)) throw new Error('после входа не получены cookies');
        const info = result.verification;
        this.accounts.setStatus(id, 'active', '', { lastLoginAt: nowIso(), lastCheckAt: nowIso(), lastError: '', adAccountsCount: info?.accounts?.length ?? 0, bcCount: info?.businessCenters?.length ?? 0 });
        this.#log(id, 'info', 'login.success', 'Вход выполнен, сессия сохранена.', user);
        success = true;
      } else if (result.outcome === 'bad_credentials') {
        this.accounts.setStatus(id, 'bad_credentials', result.message, { lastError: result.message });
        this.#log(id, 'error', 'login.bad_credentials', `Неверный логин или пароль: ${result.message}`, user);
      } else if (result.outcome === 'cancelled') {
        this.accounts.setStatus(id, this.accounts.getRow(id)?.session_enc ? 'session_expired' : 'new', 'Вход отменён.');
        this.#log(id, 'warn', 'login.cancelled', 'Вход отменён.', user);
      } else {
        this.accounts.setStatus(id, 'error', result.message, { lastError: result.message });
        this.#log(id, 'error', `login.${result.outcome}`, result.message, user);
      }
    } catch (e) {
      const message = `Ошибка запуска входа: ${firstLine(e)}`;
      this.accounts.setStatus(id, 'error', message, { lastError: message });
      this.#log(id, 'error', 'login.failed', message, user);
    } finally {
      this.flows.delete(id);
      this.sessions.delete(id);
      await session?.close();
      this.pool.interactive.release();
      this.#end(id);
    }
    if (success) {
      try { this.startSync(id, user); } catch { /* busy or disabled: next scheduled sync will pick it up */ }
    }
  }

  submitCode(id, code, user = '') {
    const flow = this.flows.get(id);
    if (!flow) throw conflict('Для этого аккаунта сейчас нет активного входа.', 'not_waiting');
    const text = String(code ?? '').trim();
    if (text.length < 4 || text.length > 10) throw badRequest('Код: от 4 до 10 символов.');
    flow.submitCode(text);
    this.#rt(id).waitingFor = null;
    this.accounts.setStatus(id, 'logging_in', 'Ввожу код подтверждения…');
    this.#log(id, 'info', 'login.code_submitted', 'Код подтверждения передан в браузер.', user);
    return this.accounts.get(id);
  }

  // ---- assist browser ----------------------------------------------------------------------------------------

  async openAssist(id, url = '', user = '') {
    this.accounts.requireRow(id);
    if (this.sessions.get(id)) return this.browserInfo(id);
    const target = url ? this.#assistUrl(url) : this.config.tiktok.homeUrl;
    if (!this.pool.interactive.tryAcquire()) throw conflict('Все слоты браузера заняты.', 'no_slot');
    try { this.#begin(id, 'assist'); } catch (e) { this.pool.interactive.release(); throw e; }
    let session = null;
    try {
      const creds = this.accounts.credentials(id);
      const state = this.accounts.loadSession(id);
      const context = await this.pool.newContext({ storageState: state?.cookies?.length ? state : undefined, proxyUrl: creds.proxy, locale: creds.locale, timezone: creds.timezone, viewport: creds.viewport, userAgent: creds.userAgent });
      const page = await context.newPage();
      session = new InteractiveSession({ kind: 'assist', accountId: id, context, page, allowedHosts: this.allowedHosts });
      session.state = 'assist';
      session.message = 'Удалённый браузер открыт.';
      this.sessions.set(id, session);
      page.goto(target, { waitUntil: 'domcontentloaded', timeout: this.config.browser.pageTimeoutMs }).catch(() => {});
      this.#log(id, 'info', 'assist.open', 'Открыт удалённый браузер.', user);
      return await session.info();
    } catch (e) {
      this.sessions.delete(id);
      await session?.close();
      this.pool.interactive.release();
      this.#end(id);
      if (e instanceof HttpError) throw e;
      throw new HttpError(500, `Не удалось запустить браузер: ${firstLine(e)}`, 'browser_failed');
    }
  }

  #assistUrl(url) {
    let target;
    try { target = new URL(url); } catch { throw badRequest('Некорректный адрес.'); }
    const host = target.hostname.toLowerCase();
    const ok = target.protocol === 'https:' && (host === 'tiktok.com' || host.endsWith('.tiktok.com'));
    if (!ok && !this.allowedHosts.includes(host)) throw badRequest('Разрешены только адреса tiktok.com.');
    return target.toString();
  }

  async closeAssist(id, user = '') {
    const session = this.sessions.get(id);
    if (!session || session.kind !== 'assist') return;
    this.sessions.delete(id);
    try {
      const state = await session.storageState();
      const page = session.page;
      const loggedIn = state?.cookies?.length && !page.isClosed() && !LOGIN_PATH.test(new URL(page.url() || 'about:blank').pathname);
      if (loggedIn) this.accounts.saveSession(id, state);
    } catch { /* browser already gone */ }
    await session.close();
    this.pool.interactive.release();
    this.#end(id);
    this.#log(id, 'info', 'assist.close', 'Удалённый браузер закрыт.', user);
  }

  async cancel(id, user = '') {
    const flow = this.flows.get(id);
    if (flow) {
      flow.cancel();
      for (let i = 0; i < 40 && this.flows.has(id); i++) await sleep(100);
    }
    await this.closeAssist(id, user);
    return this.accounts.get(id);
  }

  // Called before an account is deleted.
  async release(id) {
    await this.cancel(id).catch(() => {});
    for (let i = 0; i < 50 && this.isBusy(id); i++) await sleep(100);
  }

  // ---- remote browser ----------------------------------------------------------------------------------------

  #session(id) {
    const session = this.sessions.get(id);
    if (!session) throw new HttpError(404, 'Браузер не запущен.', 'no_browser');
    return session;
  }

  async browserInfo(id) {
    const session = this.sessions.get(id);
    if (!session) return { active: false, kind: null, width: 0, height: 0, url: '', title: '', state: '', message: '' };
    return session.info();
  }

  screenshot(id) { return this.#session(id).screenshot(); }
  input(id, cmd) { return this.#session(id).input(cmd); }

  #sweep() {
    for (const [id, session] of this.sessions) {
      if (session.kind === 'assist' && Date.now() - session.lastActivity > this.config.browser.assistIdleMs) this.closeAssist(id, 'auto').catch(() => {});
    }
  }

  async shutdown() {
    clearInterval(this.sweeper);
    for (const flow of this.flows.values()) flow.cancel();
    for (const id of [...this.sessions.keys()]) await this.closeAssist(id).catch(() => {});
    await sleep(200);
    await this.pool.close();
  }
}
