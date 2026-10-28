// Dev-only mock of docs/API.md: `node web/dev/mock-server.js [port]` (default 4010). No dependencies.
// Admin: admin / admin-password-1 (must change password on first login). Also: manager (admin), viewer (read-only).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createDb, makeCampaigns, maskProxy } from './mock-data.js';
import { FAKE_JPEG_BASE64 } from './fake-jpeg.js';

const WEB = path.resolve(import.meta.dirname, '..');
const PORT = Number(process.argv[2] ?? process.env.PORT ?? 4010);
const DELAY = Number(process.env.MOCK_DELAY ?? 40);
const JPEG = Buffer.from(FAKE_JPEG_BASE64, 'base64');
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'";
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon' };

const db = createDb();
const now = () => new Date().toISOString();
const fail = (status, error, code) => Object.assign(new Error(error), { status, code });
const later = (acc, ms, fn) => { const t = setTimeout(fn, ms); (acc._x.timers ??= []).push(t); };
const clearTimers = (acc) => { for (const t of acc._x.timers ?? []) clearTimeout(t); acc._x.timers = []; };
const touch = (a) => { a.updatedAt = now(); };
const accOr404 = (id) => db.accounts.find((a) => a.id === Number(id)) ?? (() => { throw fail(404, 'Аккаунт не найден', 'not_found'); })();

function log(level, kind, acc, message, user = '') {
  db.journal.push({ id: db.nextJournalId++, ts: now(), level, kind, accountId: acc?.id ?? null, accountLabel: acc?.label ?? '', user, message });
}

function serialize(a) {
  const own = db.adAccounts.filter((x) => x.accountId === a.id);
  const spend = new Map();
  for (const x of own) if (x.metrics.spend) spend.set(x.currency, (spend.get(x.currency) ?? 0) + x.metrics.spend);
  const { _x, ...rest } = a;
  return { ...rest, adAccountsCount: own.length, bcCount: new Set(own.map((x) => x.bcId)).size, spend7d: [...spend].map(([currency, amount]) => ({ currency, amount: Math.round(amount * 100) / 100 })) };
}
const publicUser = ({ password, ...u }) => u;

/* ---------- login / session flows ---------- */
function startLogin(a, user) {
  clearTimers(a);
  Object.assign(a, { status: 'logging_in', busy: 'login', waitingFor: null, statusDetail: DETAILS.logging_in, lastError: '' });
  a._x.url = 'https://www.tiktok.com/login/phone-or-email/email';
  touch(a); log('info', 'login', a, 'Запущен вход по паролю', user);
  later(a, 3000, () => {
    if (a.busy !== 'login') return;
    const manual = a.id % 5 === 0;
    Object.assign(a, manual ? { status: 'need_manual', waitingFor: 'manual', statusDetail: 'Показана капча — решите её в удалённом браузере' } : { status: 'need_code', waitingFor: 'code', statusDetail: 'TikTok отправил код на почту аккаунта' });
    touch(a); log('warn', manual ? 'login' : 'code', a, manual ? 'TikTok показал капчу' : 'TikTok запросил код подтверждения');
  });
}
const DETAILS = { logging_in: 'Открываю страницу входа TikTok…', checking: 'Проверяю сессию…' };
function finishOk(a) {
  Object.assign(a, { status: 'active', busy: null, waitingFor: null, hasSession: true, sessionUpdatedAt: now(), lastLoginAt: now(), lastCheckAt: now(), statusDetail: 'Сессия действительна', lastError: '' });
  touch(a);
}
function startCheck(a, user) {
  if (!a.hasSession) throw fail(409, 'У аккаунта нет сохранённой сессии', 'conflict');
  clearTimers(a);
  Object.assign(a, { status: 'checking', busy: 'check', statusDetail: DETAILS.checking });
  touch(a);
  later(a, 1500, () => {
    if (a.id % 9 === 0) { Object.assign(a, { status: 'session_expired', busy: null, statusDetail: 'Cookies больше не действуют', lastCheckAt: now() }); log('warn', 'check', a, 'Сессия истекла'); } else { finishOk(a); log('info', 'check', a, 'Сессия действительна', user); }
    touch(a);
  });
}
function startSync(a, user) {
  if (a.status !== 'active') throw fail(409, 'Синхронизировать можно только активный аккаунт', 'conflict');
  if (a.busy) throw fail(409, 'Аккаунт уже выполняет операцию', 'conflict');
  a.busy = 'sync'; touch(a);
  later(a, 2000, () => { a.busy = null; a.lastSyncAt = now(); touch(a); log('info', 'sync', a, 'Синхронизация завершена', user); });
}
function stopFlow(a) {
  clearTimers(a);
  Object.assign(a, { busy: null, waitingFor: null, status: a.hasSession ? 'active' : 'new', statusDetail: a.hasSession ? 'Сессия действительна' : 'Сессии ещё нет' });
  touch(a);
}

/* ---------- validation helpers ---------- */
const need = (cond, msg) => { if (!cond) throw fail(400, msg, 'validation'); };
const asTags = (v) => (Array.isArray(v) ? [...new Set(v.map((t) => String(t).trim()).filter(Boolean))] : []);
function checkProxy(v) { if (v && !/^(https?|socks[45]h?):\/\/\S+$/i.test(v)) throw fail(400, 'Прокси должен быть вида http://user:pass@host:port или socks5://…', 'validation'); }
function looksLikeCookies(text) { return typeof text === 'string' && text.trim().length > 15 && (/^[[{]/.test(text.trim()) || /=/.test(text) || /\tTRUE|\tFALSE/.test(text)); }

function createAccount(body, user) {
  const method = body.method === 'session' ? 'session' : 'password';
  const login = String(body.login ?? '').trim();
  if (method === 'password') need(login && body.password, 'Для входа по паролю укажите логин и пароль');
  else need(looksLikeCookies(body.session), 'Не удалось распознать cookies: вставьте JSON, cookies.txt или заголовок Cookie');
  checkProxy(body.proxy);
  if (login && db.accounts.some((a) => a.login.toLowerCase() === login.toLowerCase())) throw fail(409, 'Аккаунт с таким логином уже есть', 'conflict');
  const id = db.nextAccountId++;
  const a = { id, label: String(body.label ?? '').trim() || login || `Сессия ${id}`, login: login || `session-${id}`, method, status: 'new', statusDetail: 'Сессии ещё нет', busy: null, waitingFor: null,
    hasPassword: method === 'password', hasSession: method === 'session', sessionUpdatedAt: method === 'session' ? now() : null, proxy: maskProxy(body.proxy), tags: asTags(body.tags), client: String(body.client ?? '').trim(), notes: String(body.notes ?? ''),
    lastLoginAt: null, lastCheckAt: null, lastSyncAt: null, lastError: '', createdAt: now(), updatedAt: now(), _x: {} };
  db.accounts.push(a);
  log('info', 'audit', a, 'Добавлен аккаунт', user.login);
  if (body.autoStart) { if (method === 'password') startLogin(a, user.login); else startCheck(a, user.login); }
  return a;
}

function importLines(body, user) {
  const out = { created: 0, skipped: 0, errors: [] };
  String(body.text ?? '').split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    let parts;
    if (line.includes('|')) parts = line.split('|'); else if (line.includes('\t')) parts = line.split('\t'); else if (line.includes(';')) parts = line.split(';'); else { const k = line.indexOf(':'); parts = k > 0 ? [line.slice(0, k), line.slice(k + 1)] : [line]; }
    const [login, password, proxy, tags, client] = parts.map((p) => p.trim());
    if (!login || !password) { out.errors.push({ line: i + 1, error: 'Не указан пароль (формат login:password)' }); return; }
    if (db.accounts.some((a) => a.login.toLowerCase() === login.toLowerCase())) { out.skipped += 1; return; }
    try {
      createAccount({ method: 'password', login, password, proxy: proxy || body.proxy, tags: [...asTags(body.tags), ...asTags((tags ?? '').split(','))], client: client || body.client, autoStart: body.autoStart }, user);
      out.created += 1;
    } catch (e) { out.errors.push({ line: i + 1, error: e.message }); }
  });
  return out;
}

function patchAccount(a, body) {
  if (body.login !== undefined) {
    const login = String(body.login).trim();
    need(login, 'Логин не может быть пустым');
    if (db.accounts.some((x) => x.id !== a.id && x.login.toLowerCase() === login.toLowerCase())) throw fail(409, 'Аккаунт с таким логином уже есть', 'conflict');
    a.login = login;
  }
  if (body.label !== undefined) a.label = String(body.label).trim() || a.login;
  if (body.password) { a.hasPassword = true; }
  if (body.proxy !== undefined) { checkProxy(body.proxy); a.proxy = maskProxy(body.proxy); }
  if (body.tags !== undefined) a.tags = asTags(body.tags);
  if (body.client !== undefined) a.client = String(body.client).trim();
  if (body.notes !== undefined) a.notes = String(body.notes);
  if (body.disabled === true && a.status !== 'disabled') { clearTimers(a); Object.assign(a, { status: 'disabled', busy: null, waitingFor: null, statusDetail: 'Отключён оператором' }); }
  if (body.disabled === false && a.status === 'disabled') Object.assign(a, { status: a.hasSession ? 'active' : 'new', statusDetail: a.hasSession ? 'Сессия действительна' : 'Сессии ещё нет' });
  touch(a);
}

function bulk(body, user) {
  const ids = Array.isArray(body.ids) ? body.ids.map(Number) : [];
  need(ids.length, 'Не выбраны аккаунты');
  need(['login', 'check', 'sync', 'delete', 'tag', 'set_client', 'set_proxy', 'disable', 'enable'].includes(body.action), 'Неизвестное действие');
  const res = { ok: [], failed: [] };
  for (const id of ids) {
    const a = db.accounts.find((x) => x.id === id);
    try {
      if (!a) throw fail(404, 'Аккаунт не найден');
      switch (body.action) {
        case 'login': if (!a.hasPassword) throw fail(409, 'Нет сохранённого пароля'); if (a.busy) throw fail(409, 'Аккаунт занят'); startLogin(a, user.login); break;
        case 'check': startCheck(a, user.login); break;
        case 'sync': startSync(a, user.login); break;
        case 'delete': clearTimers(a); db.accounts.splice(db.accounts.indexOf(a), 1); db.adAccounts = db.adAccounts.filter((x) => x.accountId !== id); break;
        case 'tag': need(body.value, 'Укажите тег'); a.tags = asTags([...a.tags, body.value]); break;
        case 'set_client': a.client = String(body.value ?? '').trim(); break;
        case 'set_proxy': checkProxy(body.value); a.proxy = maskProxy(body.value); break;
        case 'disable': patchAccount(a, { disabled: true }); break;
        default: patchAccount(a, { disabled: false });
      }
      touch(a);
      res.ok.push(id);
    } catch (e) { res.failed.push({ id, error: e.message }); }
  }
  return res;
}

/* ---------- remote browser ---------- */
const browserInfo = (a) => ({
  active: a.busy === 'login' || a.busy === 'assist', kind: a.busy === 'login' ? 'login' : a.busy === 'assist' ? 'assist' : null, width: 1280, height: 800,
  url: a._x.url ?? '', title: a._x.url ? 'TikTok Ads Manager' : '', state: a.busy ? 'ready' : 'closed', message: a.waitingFor === 'manual' ? 'Требуется ручное действие: капча' : ''
});
function browserInput(a, body) {
  if (!(a.busy === 'login' || a.busy === 'assist')) throw fail(404, 'Браузер не запущен', 'not_found');
  need(['click', 'dblclick', 'type', 'key', 'scroll', 'navigate'].includes(body.type), 'Неизвестный тип ввода');
  if (body.type === 'navigate') {
    let host = '';
    try { host = new URL(body.url).hostname; } catch { /* invalid */ }
    need(host === 'tiktok.com' || host.endsWith('.tiktok.com'), 'Переход разрешён только на *.tiktok.com');
    a._x.url = body.url;
  }
  (a._x.inputs ??= []).push(body);
  if (a.waitingFor === 'manual' && body.type === 'click' && a._x.inputs.length >= 3) { stopFlow(a); finishOk(a); }
}

/* ---------- routes ---------- */
const routes = [];
const route = (method, pattern, handler, opts = {}) => routes.push({ method, re: new RegExp(`^${pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`), handler, ...opts });
const ownerOnly = (c) => { if (c.user.role !== 'owner') throw fail(403, 'Доступно только владельцу', 'forbidden'); };

route('GET', '/healthz', () => ({ ok: true }), { public: true });
route('GET', '/api/system/ping', () => ({ ok: true }));
route('POST', '/api/auth/login', (c) => {
  const key = `${c.ip}|${String(c.body.login).toLowerCase()}`;
  const fails = (db.fails ??= new Map());
  const recent = (fails.get(key) ?? []).filter((t) => Date.now() - t < 600000);
  if (recent.length >= 8) throw fail(429, 'Слишком много попыток входа. Подождите 10 минут.', 'rate_limited');
  const user = db.users.find((u) => u.login === c.body.login && !u.disabled);
  if (!user || user.password !== c.body.password) { fails.set(key, [...recent, Date.now()]); throw fail(401, 'Неверный логин или пароль', 'invalid_credentials'); }
  const sid = crypto.randomBytes(24).toString('hex');
  const csrf = crypto.randomBytes(16).toString('hex');
  db.sessions.set(sid, { userId: user.id, csrf });
  user.lastLoginAt = now();
  c.cookie = `zaliv_sid=${sid}; Path=/; HttpOnly; SameSite=Lax`;
  return { user: publicUser(user), csrf };
}, { public: true });
route('POST', '/api/auth/logout', (c) => { db.sessions.delete(c.sid); c.cookie = 'zaliv_sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0'; return [204]; });
route('GET', '/api/auth/me', (c) => ({ user: publicUser(c.user), csrf: c.sess.csrf }));
route('POST', '/api/auth/change-password', (c) => {
  need(c.user.password === c.body.currentPassword, 'Текущий пароль указан неверно');
  need(typeof c.body.newPassword === 'string' && c.body.newPassword.length >= 10, 'Новый пароль должен быть не короче 10 символов');
  Object.assign(c.user, { password: c.body.newPassword, mustChangePassword: false });
  return [204];
});

route('GET', '/api/dashboard', () => {
  const byStatus = {};
  for (const a of db.accounts) byStatus[a.status] = (byStatus[a.status] ?? 0) + 1;
  const ads = db.adAccounts;
  const count = (s) => ads.filter((x) => x.state === s).length;
  const spend = new Map();
  for (const x of ads) if (x.metrics.spend) spend.set(x.currency, (spend.get(x.currency) ?? 0) + x.metrics.spend);
  const sum = (f) => ads.reduce((s, x) => s + f(x), 0);
  const order = ['need_code', 'need_manual', 'bad_credentials', 'session_expired', 'error'];
  const attention = [
    ...db.accounts.filter((a) => order.includes(a.status)).sort((x, y) => order.indexOf(x.status) - order.indexOf(y.status))
      .map((a) => ({ kind: 'account', accountId: a.id, adAccountId: null, title: a.label, state: a.status, text: a.statusDetail || a.login })).slice(0, 32),
    ...ads.filter((x) => x.state === 'issue' || x.state === 'error').sort((x, y) => (x.state === 'error' ? -1 : 1) - (y.state === 'error' ? -1 : 1))
      .map((x) => ({ kind: 'adaccount', accountId: x.accountId, adAccountId: x.id, title: `${x.name} · ${x.accountLabel}`, state: x.state, text: x.error || x.reasons.map((r) => r.text).join(', ') || 'Нет доставки' }))
  ].slice(0, 50); // worst first, both kinds
  return {
    accounts: { total: db.accounts.length, byStatus }, adAccounts: { total: ads.length, delivering: count('delivering'), issue: count('issue'), paused: count('paused'), empty: count('empty'), error: count('error') },
    campaigns: { total: sum((x) => x.campaigns.total), working: sum((x) => x.campaigns.working), problem: sum((x) => x.campaigns.problem) },
    spend: { '7d': [...spend].map(([currency, amount]) => ({ currency, amount: Math.round(amount * 100) / 100 })) },
    attention, recentEvents: db.journal.slice(-15).reverse(),
    sync: { autoEnabled: db.settings.autoSyncEnabled, intervalMin: db.settings.syncIntervalMin, running: db.accounts.filter((a) => a.busy === 'sync').length, queued: 0, lastRunAt: new Date(db.lastSyncRunAt).toISOString(), nextRunAt: db.settings.autoSyncEnabled ? new Date(db.lastSyncRunAt + db.settings.syncIntervalMin * 60000).toISOString() : null }
  };
});

route('GET', '/api/accounts', (c) => {
  let items = db.accounts;
  const { q, status, tag, client } = c.query;
  if (q) items = items.filter((a) => `${a.label} ${a.login} ${a.client} ${a.tags.join(' ')}`.toLowerCase().includes(q.toLowerCase()));
  if (status) items = items.filter((a) => a.status === status);
  if (tag) items = items.filter((a) => a.tags.includes(tag));
  if (client) items = items.filter((a) => a.client === client);
  return { items: items.map(serialize), tags: [...new Set(db.accounts.flatMap((a) => a.tags))].sort(), clients: [...new Set(db.accounts.map((a) => a.client).filter(Boolean))].sort() };
});
route('POST', '/api/accounts', (c) => [201, serialize(createAccount(c.body, c.user))]);
route('POST', '/api/accounts/import', (c) => importLines(c.body, c.user));
route('POST', '/api/accounts/bulk', (c) => bulk(c.body, c.user));
route('GET', '/api/accounts/:id', (c) => {
  const a = accOr404(c.params.id);
  return { account: serialize(a), adAccounts: db.adAccounts.filter((x) => x.accountId === a.id), events: db.journal.filter((e) => e.accountId === a.id).slice(-50).reverse() };
});
route('PATCH', '/api/accounts/:id', (c) => { const a = accOr404(c.params.id); patchAccount(a, c.body); log('info', 'audit', a, 'Аккаунт изменён', c.user.login); return serialize(a); });
route('DELETE', '/api/accounts/:id', (c) => {
  const a = accOr404(c.params.id);
  clearTimers(a);
  db.accounts.splice(db.accounts.indexOf(a), 1);
  db.adAccounts = db.adAccounts.filter((x) => x.accountId !== a.id);
  log('warn', 'audit', null, `Удалён аккаунт ${a.label}`, c.user.login);
  return [204];
});
route('POST', '/api/accounts/:id/session', (c) => {
  const a = accOr404(c.params.id);
  need(looksLikeCookies(c.body.session), 'Не удалось распознать cookies: вставьте JSON, cookies.txt или заголовок Cookie');
  Object.assign(a, { hasSession: true, sessionUpdatedAt: now() });
  if (a.status === 'new' || a.status === 'session_expired') a.statusDetail = 'Сессия загружена, требуется проверка';
  log('info', 'session', a, 'Cookies заменены', c.user.login);
  if (c.body.check) startCheck(a, c.user.login);
  touch(a);
  return serialize(a);
});
route('GET', '/api/accounts/:id/session/export', (c) => {
  ownerOnly(c);
  const a = accOr404(c.params.id);
  need(a.hasSession, 'У аккаунта нет сессии');
  log('warn', 'audit', a, 'Экспорт cookies', c.user.login);
  return { cookies: [{ name: 'sessionid', value: 'mock-session-value', domain: '.tiktok.com', path: '/', httpOnly: true, secure: true, expires: -1 }, { name: 'sid_tt', value: 'mock', domain: '.tiktok.com', path: '/', httpOnly: true, secure: true, expires: -1 }], origins: [] };
});
route('POST', '/api/accounts/:id/login', (c) => {
  const a = accOr404(c.params.id);
  if (!a.hasPassword) throw fail(409, 'У аккаунта нет сохранённого пароля', 'conflict');
  if (a.busy) throw fail(409, 'Аккаунт уже выполняет операцию', 'conflict');
  startLogin(a, c.user.login);
  return [202, serialize(a)];
});
route('POST', '/api/accounts/:id/code', (c) => {
  const a = accOr404(c.params.id);
  if (a.waitingFor !== 'code') throw fail(409, 'Аккаунт сейчас не ждёт код подтверждения', 'not_waiting');
  need(typeof c.body.code === 'string' && /^[A-Za-z0-9]{4,10}$/.test(c.body.code), 'Код должен содержать от 4 до 10 символов');
  Object.assign(a, { waitingFor: null, status: 'checking', busy: 'check', statusDetail: 'Проверяю код…' });
  log('info', 'code', a, 'Код подтверждения отправлен', c.user.login);
  later(a, 1500, () => { finishOk(a); log('info', 'login', a, 'Вход выполнен'); });
  touch(a);
  return serialize(a);
});
route('POST', '/api/accounts/:id/cancel', (c) => { const a = accOr404(c.params.id); stopFlow(a); log('info', 'login', a, 'Вход отменён', c.user.login); return serialize(a); });
route('POST', '/api/accounts/:id/check', (c) => { const a = accOr404(c.params.id); startCheck(a, c.user.login); return [202, serialize(a)]; });
route('POST', '/api/accounts/:id/sync', (c) => { const a = accOr404(c.params.id); startSync(a, c.user.login); return [202, serialize(a)]; });

route('GET', '/api/accounts/:id/browser', (c) => browserInfo(accOr404(c.params.id)));
route('GET', '/api/accounts/:id/browser/screenshot', (c) => {
  const a = accOr404(c.params.id);
  if (!browserInfo(a).active) throw fail(404, 'Браузер не запущен', 'not_found');
  return { raw: JPEG, type: 'image/jpeg' };
});
route('POST', '/api/accounts/:id/browser/input', (c) => { browserInput(accOr404(c.params.id), c.body); return [204]; });
route('POST', '/api/accounts/:id/browser/open', (c) => {
  const a = accOr404(c.params.id);
  if (!a.hasSession) throw fail(409, 'У аккаунта нет сохранённой сессии', 'conflict');
  if (a.busy && a.busy !== 'assist') throw fail(409, 'Аккаунт занят другой операцией', 'conflict');
  Object.assign(a, { busy: 'assist' });
  a._x.url = c.body.url || 'https://ads.tiktok.com/i18n/dashboard';
  touch(a);
  return browserInfo(a);
});
route('POST', '/api/accounts/:id/browser/close', (c) => { const a = accOr404(c.params.id); if (a.busy === 'assist') stopFlow(a); return [204]; });

route('GET', '/api/ad-accounts', (c) => {
  const { q, state, accountId, bcId, currency } = c.query;
  let items = db.adAccounts;
  if (q) items = items.filter((x) => `${x.name} ${x.id} ${x.bcName} ${x.accountLabel}`.toLowerCase().includes(q.toLowerCase()));
  if (state) items = items.filter((x) => x.state === state);
  if (accountId) items = items.filter((x) => x.accountId === Number(accountId));
  if (bcId) items = items.filter((x) => x.bcId === bcId);
  if (currency) items = items.filter((x) => x.currency === currency);
  const spend = new Map();
  for (const x of items) if (x.metrics.spend) spend.set(x.currency, (spend.get(x.currency) ?? 0) + x.metrics.spend);
  const bcs = new Map(db.adAccounts.map((x) => [x.bcId, x.bcName]));
  const end = new Date(), start = new Date(Date.now() - 6 * 864e5);
  return {
    items, period: { id: '7d', st: start.toISOString().slice(0, 10), et: end.toISOString().slice(0, 10) },
    totals: { spend: [...spend].map(([cur, amount]) => ({ currency: cur, amount: Math.round(amount * 100) / 100 })) },
    bcs: [...bcs].map(([id, name]) => ({ id, name })), currencies: [...new Set(db.adAccounts.map((x) => x.currency))].sort()
  };
});
route('GET', '/api/ad-accounts/:accountId/:advertiserId/campaigns', (c) => {
  const ad = db.adAccounts.find((x) => x.accountId === Number(c.params.accountId) && x.id === c.params.advertiserId);
  if (!ad) throw fail(404, 'Кабинет не найден', 'not_found');
  const end = new Date(), start = new Date(Date.now() - 6 * 864e5);
  return { adAccount: ad, items: makeCampaigns(ad), period: { id: '7d', st: start.toISOString().slice(0, 10), et: end.toISOString().slice(0, 10) }, syncedAt: ad.syncedAt };
});

route('GET', '/api/journal', (c) => {
  const limit = Math.min(Number(c.query.limit) || 100, 500);
  let items = [...db.journal].reverse();
  if (c.query.accountId) items = items.filter((e) => e.accountId === Number(c.query.accountId));
  if (c.query.level) items = items.filter((e) => e.level === c.query.level);
  if (c.query.before) items = items.filter((e) => e.id < Number(c.query.before));
  return { items: items.slice(0, limit), hasMore: items.length > limit };
});

route('GET', '/api/settings', () => ({ ...db.settings }));
route('PUT', '/api/settings', (c) => {
  const { autoSyncEnabled, syncIntervalMin } = c.body;
  if (autoSyncEnabled !== undefined) db.settings.autoSyncEnabled = !!autoSyncEnabled;
  if (syncIntervalMin !== undefined) { need(Number.isInteger(syncIntervalMin) && syncIntervalMin >= 15 && syncIntervalMin <= 1440, 'Интервал должен быть от 15 до 1440 минут'); db.settings.syncIntervalMin = syncIntervalMin; }
  return { ...db.settings };
});
route('GET', '/api/users', (c) => { ownerOnly(c); return { items: db.users.map(publicUser) }; });
route('POST', '/api/users', (c) => {
  ownerOnly(c);
  const { login, password, role } = c.body;
  need(typeof login === 'string' && login.trim().length >= 3, 'Логин не короче 3 символов');
  need(typeof password === 'string' && password.length >= 10, 'Пароль не короче 10 символов');
  need(['owner', 'admin', 'viewer'].includes(role), 'Неизвестная роль');
  if (db.users.some((u) => u.login === login.trim())) throw fail(409, 'Пользователь с таким логином уже есть', 'conflict');
  const user = { id: db.nextUserId++, login: login.trim(), password, role, mustChangePassword: true, disabled: false, createdAt: now(), lastLoginAt: null };
  db.users.push(user);
  return [201, publicUser(user)];
});
route('PATCH', '/api/users/:id', (c) => {
  ownerOnly(c);
  const u = db.users.find((x) => x.id === Number(c.params.id));
  if (!u) throw fail(404, 'Пользователь не найден', 'not_found');
  if (c.body.role !== undefined) { need(['owner', 'admin', 'viewer'].includes(c.body.role), 'Неизвестная роль'); u.role = c.body.role; }
  if (c.body.password) { need(c.body.password.length >= 10, 'Пароль не короче 10 символов'); u.password = c.body.password; u.mustChangePassword = true; }
  if (c.body.disabled !== undefined) { if (u.id === c.user.id) throw fail(400, 'Нельзя отключить самого себя', 'validation'); u.disabled = !!c.body.disabled; }
  return publicUser(u);
});
route('DELETE', '/api/users/:id', (c) => {
  ownerOnly(c);
  const u = db.users.find((x) => x.id === Number(c.params.id));
  if (!u) throw fail(404, 'Пользователь не найден', 'not_found');
  if (u.id === c.user.id) throw fail(400, 'Нельзя удалить самого себя', 'validation');
  db.users.splice(db.users.indexOf(u), 1);
  return [204];
});
route('GET', '/api/system', () => ({
  version: '0.1.0-mock', uptimeSec: Math.round((Date.now() - db.startedAt) / 1000) + 93784, node: process.version, tiktokOrigin: 'https://ads.tiktok.com',
  browser: { ready: true, headless: true, interactive: { active: db.accounts.filter((a) => a.busy === 'login' || a.busy === 'assist').length, max: 6 }, background: { active: db.accounts.filter((a) => a.busy === 'check' || a.busy === 'sync').length, max: 4, queued: 0 } },
  scheduler: { enabled: db.settings.autoSyncEnabled, intervalMin: db.settings.syncIntervalMin, lastRunAt: new Date(db.lastSyncRunAt).toISOString(), nextRunAt: db.settings.autoSyncEnabled ? new Date(db.lastSyncRunAt + db.settings.syncIntervalMin * 60000).toISOString() : null, running: db.accounts.some((a) => a.busy === 'sync') },
  counts: { accounts: db.accounts.length, adAccounts: db.adAccounts.length, campaigns: db.adAccounts.reduce((s, x) => s + x.campaigns.total, 0) }
}));
route('POST', '/api/system/sync-all', (c) => {
  let queued = 0;
  for (const a of db.accounts) if (a.status === 'active' && !a.busy) { startSync(a, c.user.login); queued += 1; }
  db.lastSyncRunAt = Date.now();
  return [202, { queued }];
});

/* ---------- http plumbing ---------- */
const cookieOf = (req, name) => (req.headers.cookie ?? '').split(/;\s*/).map((p) => p.split('=')).find(([k]) => k === name)?.[1];
function send(res, status, data, extra = {}) {
  const headers = { 'content-security-policy': CSP, 'x-content-type-options': 'nosniff', 'cache-control': 'no-store', ...extra };
  if (data === undefined) { res.writeHead(status, headers); res.end(); return; }
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(data));
}
async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  try { return JSON.parse(text); } catch { throw fail(400, 'Некорректный JSON', 'validation'); }
}

async function handleApi(req, res, url) {
  const match = routes.map((r) => (r.method === req.method ? { r, m: r.re.exec(url.pathname) } : null)).find((x) => x?.m);
  if (!match) throw fail(404, 'Не найдено', 'not_found');
  const ctx = { req, ip: req.socket.remoteAddress, query: Object.fromEntries(url.searchParams), params: match.m.groups ?? {}, body: req.method === 'GET' ? {} : await readBody(req), cookie: null };
  if (!match.r.public) {
    const sid = cookieOf(req, 'zaliv_sid');
    const sess = db.sessions.get(sid);
    const user = sess && db.users.find((u) => u.id === sess.userId && !u.disabled);
    if (!user) throw fail(401, 'Требуется вход', 'unauthorized');
    Object.assign(ctx, { sid, sess, user });
    const isAuth = url.pathname.startsWith('/api/auth/') || url.pathname === '/api/system/ping';
    if (user.mustChangePassword && !isAuth) throw fail(403, 'Сначала смените пароль', 'must_change_password');
    if (req.method !== 'GET' && req.headers['x-csrf-token'] !== sess.csrf) throw fail(403, 'Неверный CSRF-токен', 'csrf');
    if (req.method !== 'GET' && user.role === 'viewer' && !isAuth) throw fail(403, 'Недостаточно прав: режим только для чтения', 'forbidden');
  }
  const out = match.r.handler(ctx);
  const extra = ctx.cookie ? { 'set-cookie': ctx.cookie } : {};
  if (out?.raw) { res.writeHead(200, { 'content-type': out.type, 'cache-control': 'no-store', 'content-security-policy': CSP, ...extra }); res.end(out.raw); return; }
  if (Array.isArray(out)) send(res, out[0], out[1], extra); else send(res, 200, out, extra);
}

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(WEB, rel));
  if (!file.startsWith(WEB) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'content-security-policy': CSP }); res.end('Not found'); return; }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', 'content-security-policy': CSP, 'x-content-type-options': 'nosniff', 'cache-control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/') || url.pathname === '/healthz') {
      if (DELAY) await new Promise((r) => setTimeout(r, DELAY));
      await handleApi(req, res, url);
    } else serveStatic(req, res, url);
  } catch (e) {
    if (!e.status) console.error(e);
    send(res, e.status ?? 500, { error: e.status ? e.message : 'Внутренняя ошибка сервера', code: e.code ?? 'internal' });
  }
}).listen(PORT, () => console.log(`Zaliv mock: http://localhost:${PORT}  (admin / admin-password-1)`));
