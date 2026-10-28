import { nowIso } from '../db/index.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { maskProxy, normalizeProxy } from '../lib/proxy.js';
import { emptyState, parseSession } from '../lib/cookies.js';
import { bool, oneOf, str, tags as parseTags } from '../lib/validate.js';

export const STATUSES = ['new', 'logging_in', 'need_code', 'need_manual', 'checking', 'active', 'session_expired', 'bad_credentials', 'error', 'disabled'];
const VIEWPORTS = ['1366x768', '1440x900', '1536x864', '1600x900', '1920x1080'];
const MAX_IMPORT_LINES = 2000;

const jsonList = (text) => { try { const v = JSON.parse(text || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };

export class AccountService {
  constructor({ db, vault, runtime, config, events }) {
    Object.assign(this, { db, vault, runtime, config, events });
    this.cookieOptions = (() => {
      const host = new URL(config.tiktok.origin).hostname;
      const real = /(^|\.)tiktok\.com$/i.test(host);
      return real ? {} : { defaultDomain: host, extraHosts: [host] };
    })();
  }

  getRow(id) { return this.db.prepare('SELECT * FROM accounts WHERE id = ?').get(id); }

  requireRow(id) {
    const row = this.getRow(id);
    if (!row) throw notFound('Аккаунт не найден.');
    return row;
  }

  #spendMap() {
    const rows = this.db.prepare("SELECT account_id, currency, SUM(spend) AS amount FROM ad_accounts WHERE state != 'error' AND currency != '' GROUP BY account_id, currency").all();
    const map = new Map();
    for (const r of rows) {
      if (!map.has(r.account_id)) map.set(r.account_id, []);
      map.get(r.account_id).push({ currency: r.currency, amount: Math.round(r.amount * 100) / 100 });
    }
    return map;
  }

  dto(row, spendMap = null) {
    const rt = this.runtime.get(row.id) || {};
    let proxy = '';
    try { proxy = maskProxy(this.vault.decrypt(row.proxy_enc)); } catch { proxy = '***'; }
    const spend = (spendMap || this.#spendMap()).get(row.id) || [];
    return {
      id: row.id,
      label: row.label || row.login || `Аккаунт ${row.id}`,
      login: row.login,
      method: row.method,
      status: row.disabled ? 'disabled' : row.status,
      statusDetail: row.status_detail,
      busy: rt.busy || null,
      waitingFor: rt.waitingFor || null,
      hasPassword: !!row.password_enc,
      hasSession: !!row.session_enc,
      sessionUpdatedAt: row.session_updated_at,
      proxy,
      tags: jsonList(row.tags),
      client: row.client,
      notes: row.notes,
      adAccountsCount: row.ad_accounts_count,
      bcCount: row.bc_count,
      spend7d: spend,
      lastLoginAt: row.last_login_at,
      lastCheckAt: row.last_check_at,
      lastSyncAt: row.last_sync_at,
      lastError: row.last_error,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  get(id) { return this.dto(this.requireRow(id)); }

  list({ q = '', status = '', tag = '', client = '' } = {}) {
    const rows = this.db.prepare('SELECT * FROM accounts ORDER BY id DESC').all();
    const spend = this.#spendMap();
    const needle = String(q).trim().toLowerCase();
    const tagNeedle = String(tag).trim().toLowerCase();
    const allTags = new Set();
    const allClients = new Set();
    const items = [];
    for (const row of rows) {
      const dto = this.dto(row, spend);
      dto.tags.forEach((t) => allTags.add(t));
      if (dto.client) allClients.add(dto.client);
      if (status && dto.status !== status) continue;
      if (client && dto.client !== client) continue;
      if (tagNeedle && !dto.tags.some((t) => t.toLowerCase() === tagNeedle)) continue;
      if (needle && !`${dto.label} ${dto.login} ${dto.client} ${dto.tags.join(' ')} ${dto.notes} ${dto.id}`.toLowerCase().includes(needle)) continue;
      items.push(dto);
    }
    const sort = (a, b) => a.localeCompare(b, 'ru');
    return { items, tags: [...allTags].sort(sort), clients: [...allClients].sort(sort) };
  }

  create(input, actor = '') {
    const method = oneOf(str(input.method || 'password'), ['password', 'session'], 'Метод');
    const login = str(input.login, { name: 'Логин', max: 200 });
    const password = str(input.password, { name: 'Пароль', max: 300, trim: false });
    if (method === 'password' && (!login || !password)) throw badRequest('Для входа по паролю нужны логин и пароль.');
    let sessionEnc = null;
    let sessionAt = null;
    let warnings = [];
    if (method === 'session') {
      const parsed = parseSession(input.session, this.cookieOptions);
      warnings = parsed.warnings;
      sessionEnc = this.vault.encrypt(JSON.stringify({ cookies: parsed.cookies, origins: parsed.origins }));
      sessionAt = nowIso();
    }
    if (login) {
      const dup = this.db.prepare('SELECT id FROM accounts WHERE lower(login) = lower(?)').get(login);
      if (dup) throw conflict(`Аккаунт с логином ${login} уже есть (№${dup.id}).`);
    }
    const proxy = normalizeProxy(input.proxy);
    const stamp = nowIso();
    const info = this.db.prepare(`INSERT INTO accounts (label, login, method, password_enc, session_enc, session_updated_at, proxy_enc, viewport, tags, client, notes, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?)`).run(
      str(input.label, { name: 'Название', max: 160 }), login, method, this.vault.encrypt(password), sessionEnc, sessionAt, this.vault.encrypt(proxy),
      VIEWPORTS[Math.floor(Math.random() * VIEWPORTS.length)], JSON.stringify(parseTags(input.tags)),
      str(input.client, { name: 'Клиент', max: 120 }), str(input.notes, { name: 'Заметки', max: 4000, trim: false }), stamp, stamp
    );
    const id = Number(info.lastInsertRowid);
    const row = this.getRow(id);
    this.events.add({ kind: 'account.create', accountId: id, accountLabel: row.label || row.login, user: actor, message: method === 'session' ? 'Аккаунт добавлен (сессия).' : 'Аккаунт добавлен (логин и пароль).' });
    return { row, warnings };
  }

  update(id, patch, actor = '') {
    const row = this.requireRow(id);
    const sets = [];
    const args = [];
    const put = (col, value) => { sets.push(`${col} = ?`); args.push(value); };
    let credentialsChanged = false;

    if (patch.label !== undefined) put('label', str(patch.label, { name: 'Название', max: 160 }));
    if (patch.login !== undefined) {
      const login = str(patch.login, { name: 'Логин', max: 200 });
      if (login && login.toLowerCase() !== row.login.toLowerCase()) {
        const dup = this.db.prepare('SELECT id FROM accounts WHERE lower(login) = lower(?) AND id != ?').get(login, id);
        if (dup) throw conflict(`Аккаунт с логином ${login} уже есть (№${dup.id}).`);
      }
      if (login !== row.login) credentialsChanged = true;
      put('login', login);
    }
    if (patch.password) {
      put('password_enc', this.vault.encrypt(str(patch.password, { name: 'Пароль', max: 300, trim: false })));
      credentialsChanged = true;
    }
    if (patch.proxy !== undefined) put('proxy_enc', this.vault.encrypt(normalizeProxy(patch.proxy)));
    if (patch.tags !== undefined) put('tags', JSON.stringify(parseTags(patch.tags)));
    if (patch.client !== undefined) put('client', str(patch.client, { name: 'Клиент', max: 120 }));
    if (patch.notes !== undefined) put('notes', str(patch.notes, { name: 'Заметки', max: 4000, trim: false }));
    if (patch.disabled !== undefined) put('disabled', bool(patch.disabled) ? 1 : 0);
    if (patch.timezone !== undefined) put('timezone', str(patch.timezone, { name: 'Часовой пояс', max: 60 }));
    if (patch.locale !== undefined) put('locale', str(patch.locale, { name: 'Язык', max: 20 }));
    if (credentialsChanged && row.status === 'bad_credentials') { put('status', 'new'); put('status_detail', ''); }
    if (!sets.length) return row;
    put('updated_at', nowIso());
    this.db.prepare(`UPDATE accounts SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);
    const next = this.getRow(id);
    this.events.add({ kind: 'account.update', accountId: id, accountLabel: next.label || next.login, user: actor, message: 'Данные аккаунта изменены.' });
    return next;
  }

  remove(id, actor = '') {
    const row = this.requireRow(id);
    this.db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
    this.events.add({ kind: 'account.delete', accountLabel: row.label || row.login, user: actor, message: `Аккаунт удалён (№${id}).` });
  }

  // Internal status updates from login / check / sync operations.
  setStatus(id, status, detail = '', extra = {}) {
    const sets = ['status = ?', 'status_detail = ?', 'updated_at = ?'];
    const args = [status, String(detail).slice(0, 400), nowIso()];
    const cols = { lastLoginAt: 'last_login_at', lastCheckAt: 'last_check_at', lastSyncAt: 'last_sync_at', lastError: 'last_error', adAccountsCount: 'ad_accounts_count', bcCount: 'bc_count' };
    for (const [key, col] of Object.entries(cols)) {
      if (extra[key] !== undefined) { sets.push(`${col} = ?`); args.push(extra[key]); }
    }
    this.db.prepare(`UPDATE accounts SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);
  }

  credentials(id) {
    const row = this.requireRow(id);
    return {
      id, label: row.label || row.login, login: row.login, password: this.vault.decrypt(row.password_enc),
      proxy: this.vault.decrypt(row.proxy_enc), userAgent: row.user_agent, locale: row.locale, timezone: row.timezone, viewport: row.viewport
    };
  }

  saveFingerprint(id, { userAgent, locale, timezone }) {
    this.db.prepare('UPDATE accounts SET user_agent = ?, locale = ?, timezone = ? WHERE id = ?').run(userAgent, locale, timezone, id);
  }

  saveSession(id, state) {
    if (!state?.cookies?.length) return false;
    this.db.prepare('UPDATE accounts SET session_enc = ?, session_updated_at = ?, updated_at = ? WHERE id = ?')
      .run(this.vault.encrypt(JSON.stringify({ cookies: state.cookies, origins: state.origins || [] })), nowIso(), nowIso(), id);
    return true;
  }

  loadSession(id) {
    const row = this.requireRow(id);
    if (!row.session_enc) return null;
    try { return JSON.parse(this.vault.decrypt(row.session_enc)); } catch { return emptyState(); }
  }

  replaceSession(id, text, actor = '') {
    const row = this.requireRow(id);
    const parsed = parseSession(text, this.cookieOptions);
    this.saveSession(id, parsed);
    this.db.prepare("UPDATE accounts SET status = 'new', status_detail = '', last_error = '' WHERE id = ?").run(id);
    this.events.add({ kind: 'account.session', accountId: id, accountLabel: row.label || row.login, user: actor, message: `Сессия заменена (cookies: ${parsed.cookies.length}).` });
    return parsed;
  }

  importLines(text, defaults = {}, actor = '') {
    const lines = String(text ?? '').split(/\r?\n/);
    if (lines.length > MAX_IMPORT_LINES) throw badRequest(`Слишком много строк (максимум ${MAX_IMPORT_LINES}).`);
    const result = { created: 0, skipped: 0, errors: [], ids: [] };
    const seen = new Set();
    const defTags = parseTags(defaults.tags);
    lines.forEach((raw, index) => {
      const line = raw.trim();
      if (!line || line.startsWith('#')) return;
      let fields;
      if (line.includes('|')) fields = line.split('|');
      else if (line.includes('\t')) fields = line.split('\t');
      else if (line.includes(';')) fields = line.split(';');
      else { const i = line.indexOf(':'); fields = i < 0 ? [line] : [line.slice(0, i), line.slice(i + 1)]; }
      fields = fields.map((f) => f.trim());
      const [login, password, proxy, rowTags, client] = fields;
      if (!login || !password) { result.errors.push({ line: index + 1, error: 'Нужны логин и пароль (login:password).' }); return; }
      const key = login.toLowerCase();
      if (seen.has(key) || this.db.prepare('SELECT 1 FROM accounts WHERE lower(login) = ?').get(key)) { result.skipped++; return; }
      seen.add(key);
      try {
        const { row } = this.create({
          method: 'password', login, password, proxy: proxy || defaults.proxy,
          tags: [...defTags, ...parseTags(rowTags)], client: client || defaults.client
        }, actor);
        result.created++;
        result.ids.push(row.id);
      } catch (e) {
        result.errors.push({ line: index + 1, error: e.message });
      }
    });
    return result;
  }
}
