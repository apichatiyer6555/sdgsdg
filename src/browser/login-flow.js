import { conflict } from '../lib/errors.js';
import { detectLoginState } from './page-scripts.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (a, b) => a + Math.random() * (b - a);
const BAD_CREDENTIALS = /incorrect|wrong|invalid (email|account|password|username)|not match|doesn.t exist|does not exist|not registered|no account/i;
const BAD_CODE = /code/i;
const CONFIRM_RE = '^(verify|confirm|submit|next|continue|log in|sign in|ok|done)$';

/**
 * Drives the TikTok for Business login page for one account.
 *
 * States reported through onState: logging_in -> (need_code | need_manual)* -> done.
 * The operator supplies the e-mail code with submitCode(); captcha / unknown steps are solved by hand in the
 * remote browser (InteractiveSession) while this flow keeps watching the page and finishes on its own.
 * run() resolves with { outcome: 'success' | 'bad_credentials' | 'failed' | 'cancelled' | 'timeout', message }.
 */
export class LoginFlow {
  constructor({ session, creds, config, onState, log, verify }) {
    Object.assign(this, { session, creds, config, onState, log, verify });
    this.cancelled = false;
    this.waiter = null;
    this.phase = 'starting';
    this.phaseSince = Date.now();
  }

  get page() { return this.session.page; }
  get waitingFor() { return this.phase === 'need_code' ? 'code' : this.phase === 'need_manual' ? 'manual' : null; }

  #phase(phase, message = '') {
    if (this.phase !== phase) this.phaseSince = Date.now();
    this.phase = phase;
    this.session.state = phase;
    this.session.message = message;
    const status = phase === 'need_code' ? 'need_code' : phase === 'need_manual' ? 'need_manual' : 'logging_in';
    this.onState(status, message);
  }

  submitCode(code) {
    if (!this.waiter) throw conflict('Сейчас код не требуется.', 'not_waiting');
    const waiter = this.waiter;
    this.waiter = null;
    waiter.resolve(String(code).trim());
  }

  cancel() {
    this.cancelled = true;
    if (this.waiter) { const w = this.waiter; this.waiter = null; w.reject(new Error('cancelled')); }
  }

  async #detect() {
    try { return await this.page.evaluate(detectLoginState); } catch { return null; }
  }

  async #setValue(selector, value) {
    const loc = this.page.locator(selector).first();
    await loc.click({ timeout: 10_000 });
    await loc.fill(value);
    let current = await loc.inputValue();
    if (current !== value) {
      await loc.fill('');
      await loc.pressSequentially(value, { delay: 45 });
      current = await loc.inputValue();
    }
    if (current !== value) throw new Error('не удалось ввести значение в поле');
  }

  async #submitCredentials() {
    const { login, password } = this.creds;
    await this.#setValue('input[name=email], input[type=email]', login);
    await sleep(jitter(250, 700));
    await this.#setValue('input[name=password], input[type=password]', password);
    await sleep(jitter(300, 800));
    const button = this.page.locator('button.login-btn, button:text-is("Log in")').first();
    if (await button.count()) await button.click({ timeout: 10_000 });
    else await this.page.keyboard.press('Enter');
  }

  async #enterCode(code) {
    const { page } = this;
    let input = page.locator('[data-zaliv-code="1"]').first();
    if (!(await input.count())) input = page.locator('input:visible:not([type=password]):not([type=email]):not([type=hidden]):not([type=checkbox]):not([type=radio])').first();
    if (!(await input.count())) throw new Error('поле для кода не найдено');
    await input.click({ timeout: 10_000 });
    await input.fill(code);
    if ((await input.inputValue()) !== code) { await input.fill(''); await input.pressSequentially(code, { delay: 60 }); }
    await sleep(jitter(300, 700));
    const handle = await page.evaluateHandle((re) => {
      const regex = new RegExp(re, 'i');
      let node = document.querySelector('[data-zaliv-code="1"]') || document.activeElement;
      for (let i = 0; i < 7 && node; i++) {
        node = node.parentElement;
        if (!node) break;
        const found = [...node.querySelectorAll('button,[role="button"]')].find((b) => {
          const r = b.getBoundingClientRect();
          return r.width > 1 && r.height > 1 && !b.disabled && regex.test((b.innerText || '').trim());
        });
        if (found) return found;
      }
      return null;
    }, CONFIRM_RE);
    const el = handle.asElement();
    if (el) await el.click({ timeout: 10_000 }); else await page.keyboard.press('Enter');
  }

  // Waits for the operator's code but keeps watching the page: if it moves on by itself, the wait is dropped.
  async #waitForCode() {
    const promise = new Promise((resolve, reject) => { this.waiter = { resolve, reject }; });
    promise.catch(() => {});
    const deadline = Date.now() + this.config.browser.codeWaitMs;
    while (!this.cancelled) {
      const winner = await Promise.race([promise.then((code) => ({ code })).catch(() => ({ cancelled: true })), sleep(1200).then(() => null)]);
      if (winner?.cancelled) return null;
      if (winner?.code) return winner.code;
      if (Date.now() > deadline) { this.waiter = null; return undefined; }
      const s = await this.#detect();
      if (s && !s.code) { this.waiter = null; return null; }
    }
    return null;
  }

  async run() {
    const { config } = this;
    const b = config.browser;
    try {
      this.#phase('starting', 'Открываю страницу входа TikTok…');
      try {
        await this.page.goto(config.tiktok.loginUrl, { waitUntil: 'domcontentloaded', timeout: b.pageTimeoutMs });
      } catch (e) {
        return { outcome: 'failed', message: `Не удалось открыть страницу входа: ${String(e.message).split('\n')[0].slice(0, 160)}` };
      }
      let formReady = true;
      try { await this.page.waitForSelector('input[name=email], input[type=email]', { state: 'visible', timeout: 30_000 }); } catch { formReady = false; }
      await sleep(jitter(800, 1600));
      const first = await this.#detect();
      if (first && !first.onLogin) return await this.#finish();
      const baselineError = first?.errorText || '';

      if (formReady && first?.hasForm) {
        this.#phase('submitted', 'Ввожу логин и пароль…');
        try { await this.#submitCredentials(); } catch (e) {
          this.#phase('need_manual', `Не удалось заполнить форму входа (${String(e.message).split('\n')[0].slice(0, 100)}). Откройте браузер и войдите вручную.`);
        }
      } else {
        this.#phase('need_manual', 'Форма входа не найдена или не загрузилась. Откройте браузер и посмотрите, что показывает TikTok.');
      }
      return await this.#loop(baselineError);
    } catch (e) {
      if (this.cancelled) return { outcome: 'cancelled', message: 'Вход отменён.' };
      return { outcome: 'failed', message: `Ошибка входа: ${String(e.message).split('\n')[0].slice(0, 200)}` };
    }
  }

  async #finish() {
    const result = await this.verify();
    if (result.ok) return { outcome: 'success', message: 'Вход выполнен.', verification: result };
    return { outcome: 'failed', message: result.message || 'Вход не подтверждён.' };
  }

  async #loop(baselineError) {
    const b = this.config.browser;
    let submittedAt = Date.now();
    let ignoreCodeUntil = 0;
    let codeAttempts = 0;
    let lastVerifyAt = 0;
    let verifyFails = 0;

    while (!this.cancelled) {
      await sleep(b.pollMs);
      if (this.session.closed) return { outcome: 'cancelled', message: 'Браузер закрыт.' };
      if (this.phase === 'need_manual' && Date.now() - this.phaseSince > b.manualWaitMs) return { outcome: 'timeout', message: 'Время ожидания ручного входа истекло.' };
      const s = await this.#detect();
      if (!s) continue;

      if (!s.onLogin && !s.code && !s.captcha) {
        if (Date.now() - lastVerifyAt < 8000) continue;
        lastVerifyAt = Date.now();
        const result = await this.verify();
        if (result.ok) return { outcome: 'success', message: 'Вход выполнен.', verification: result };
        if (++verifyFails >= 6) return { outcome: 'failed', message: result.message || 'Вход не подтверждён.' };
        this.#phase('need_manual', 'Вход не завершён: TikTok не подтвердил сессию. Откройте браузер и завершите вход вручную.');
        continue;
      }

      if (s.code && Date.now() >= ignoreCodeUntil) {
        if (this.phase === 'need_code') continue;
        if (codeAttempts >= 5) return { outcome: 'failed', message: 'Код не принят 5 раз подряд.' };
        const hint = codeAttempts ? 'TikTok не принял код. Введите новый код из письма.' : 'TikTok запросил код подтверждения — введите код из письма.';
        this.#phase('need_code', hint);
        this.log('info', 'login.code_requested', 'TikTok запросил код подтверждения.');
        const code = await this.#waitForCode();
        if (this.cancelled) break;
        if (code === undefined) return { outcome: 'timeout', message: 'Код не введён вовремя.' };
        if (code === null) { this.#phase('submitted', 'Продолжаю вход…'); continue; }
        codeAttempts++;
        this.#phase('submitted', 'Ввожу код подтверждения…');
        try { await this.#enterCode(code); } catch (e) {
          this.#phase('need_manual', `Не удалось ввести код (${String(e.message).split('\n')[0].slice(0, 100)}). Введите его в удалённом браузере.`);
          continue;
        }
        submittedAt = Date.now();
        ignoreCodeUntil = Date.now() + 6000;
        continue;
      }

      if (s.captcha) {
        if (this.phase !== 'need_manual') this.log('warn', 'login.captcha', 'TikTok показывает проверку (капчу).');
        this.#phase('need_manual', 'TikTok показывает капчу или проверку. Откройте удалённый браузер и пройдите её — вход завершится сам.');
        continue;
      }

      if (s.errorText && s.errorText !== baselineError && this.phase !== 'need_manual') {
        if (this.phase === 'submitted' && codeAttempts > 0 && BAD_CODE.test(s.errorText)) {
          ignoreCodeUntil = 0;
          this.#phase('submitted', s.errorText);
          continue;
        }
        if (BAD_CREDENTIALS.test(s.errorText)) return { outcome: 'bad_credentials', message: s.errorText };
        return { outcome: 'failed', message: `TikTok: ${s.errorText}` };
      }

      if (this.phase === 'submitted' && Date.now() - submittedAt > b.loginTimeoutMs) {
        this.#phase('need_manual', 'TikTok не ответил на вход вовремя. Откройте удалённый браузер и посмотрите, что на странице.');
      }
    }
    return { outcome: 'cancelled', message: 'Вход отменён.' };
  }
}
