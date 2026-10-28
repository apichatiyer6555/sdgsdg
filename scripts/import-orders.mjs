#!/usr/bin/env node
// One-off helper: import account-shop order files (login|password|email|cookies…) into the panel
// via the public API and verify the sessions. Prints only non-secret summaries.
//   node scripts/import-orders.mjs <panel-url> <login> <password> file1.txt file2.txt…
import { readFileSync } from 'node:fs';

const [BASE, LOGIN, PASSWORD, ...files] = process.argv.slice(2);
if (!BASE || !LOGIN || !PASSWORD || !files.length) {
  console.error('usage: node scripts/import-orders.mjs <panel-url> <login> <password> <order-file>…');
  process.exit(1);
}

let cookieHeader = '';
let csrf = '';
async function api(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookieHeader ? { cookie: cookieHeader } : {}), ...(method !== 'GET' ? { 'x-csrf-token': csrf } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookieHeader = setCookie.split(';')[0];
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${data?.error || res.statusText}`);
  return data;
}

const EMAIL_RE = /^[\w.+-]+@[\w-]+\.[\w.]+$/;
const COOKIE_MARK = /(sessionid|sid_tt|sid_guard|ttwid)=/;

function parseOrder(file) {
  const lines = readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.trim());
  const data = lines[lines.length - 1];
  let parts = data.split(/[|\t]/).map((p) => p.trim());
  if (parts.length === 1) {
    // "id : email : password : … : [cookies]" and short "email:password" lines
    if (data.includes(' : ')) parts = data.split(' : ').map((p) => p.trim());
    else if (data.includes(':')) parts = data.split(':').map((p) => p.trim());
  }
  const order = { file, label: '', login: '', password: '', emailPassword: '', session: '', advertiserId: '' };
  order.advertiserId = (parts.find((p) => /^\d{15,20}$/.test(p)) || '').slice(0, 20);
  const cookieField = parts.find((p) => COOKIE_MARK.test(p) && p.includes(';'));
  const cookieJson = parts.find((p) => p.trimStart().startsWith(':[{') || p.trimStart().startsWith('[{'));
  if (cookieField) {
    // keep only the "name=value; …" part (shops sometimes prefix a label)
    const at = cookieField.search(/[A-Za-z_0-9-]+=[^;]*;/);
    order.session = at > 0 ? cookieField.slice(at) : cookieField;
  }
  if (!order.session && cookieJson) {
    const from = cookieJson.indexOf('[');
    const to = cookieJson.lastIndexOf(']');
    if (from >= 0 && to > from) order.session = cookieJson.slice(from, to + 1);
  }
  const email = parts.find((p) => EMAIL_RE.test(p));
  if (email) order.login = email;
  else {
    const user = parts.find((p) => /^user\d{6,}$/i.test(p));
    if (user) order.login = user;
  }
  const rest = parts.filter((p) => p !== email && p !== cookieField && !/^user\d{6,}$/i.test(p) && !/^\d{10,}$/.test(p) && !p.toLowerCase().startsWith('http'));
  // password: the shortest secret-ish field; email password: another short field after it
  const short = rest.filter((p) => p.length >= 4 && p.length <= 40);
  if (short.length) order.password = short[0];
  if (short.length > 1) order.emailPassword = short[1];
  order.label = (file.split('/').pop() || file).replace(/\.txt$/, '').slice(0, 40);
  return order;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const summarize = (a) => `#${a.id} ${a.status}${a.statusDetail ? ` (${a.statusDetail.slice(0, 80)})` : ''} кабинетов=${a.adAccountsCount} BC=${a.bcCount}${a.spend7d.length ? ` расход7д=${JSON.stringify(a.spend7d)}` : ''}`;

// sign in; the panel forces a password change on fresh users
let me = await api('POST', '/api/auth/login', { login: LOGIN, password: PASSWORD });
csrf = me.csrf;
if (me.user.mustChangePassword) {
  const NEW = PASSWORD + '-X9';
  await api('POST', '/api/auth/change-password', { currentPassword: PASSWORD, newPassword: NEW });
  me = await api('POST', '/api/auth/login', { login: LOGIN, password: NEW });
  csrf = me.csrf;
  console.log(`вход как ${me.user.login} (пароль сменён на ${NEW.slice(0, 2)}…${NEW.slice(-3)})`);
} else {
  console.log(`вход как ${me.user.login}`);
}

const orders = files.map(parseOrder);
const created = [];
const seen = new Set();
for (const o of orders) {
  const method = o.session ? 'session' : 'password';
  if (method === 'password' && (!o.login || !o.password)) { console.log(`нет данных, пропущено: ${o.label}`); continue; }
  const key = o.session || `${o.login}:${o.password}`;
  if (seen.has(key)) { console.log(`дубль пропущен: ${o.label}`); continue; }
  seen.add(key);
  const acc = await api('POST', '/api/accounts', {
    method, label: o.label, login: o.login || undefined, password: method === 'password' ? o.password : undefined,
    session: o.session || undefined, notes: o.advertiserId ? `ID кабинета из заказа: ${o.advertiserId}` : undefined,
    tags: ['заказ'], autoStart: method === 'session'
  });
  if (method === 'session' && o.password) await api('PATCH', `/api/accounts/${acc.id}`, { password: o.password });
  created.push({ id: acc.id, label: o.label, method, hasSession: acc.hasSession, warnings: acc.warnings || [] });
  console.log(`добавлен ${method === 'session' ? '(сессия' : '(пароль'}${method === 'session' ? ')' : ')'}: ${o.label} — ${o.login ? 'логин есть' : 'логина нет'}${acc.warnings?.length ? `, предупреждения: ${acc.warnings.join(' ')}` : ''}`);
}

// wait for session checks to settle
const settle = async (timeoutMs) => {
  const t0 = Date.now();
  for (;;) {
    const list = (await api('GET', '/api/accounts')).items;
    const busy = list.filter((a) => a.busy);
    if (!busy.length) return list;
    if (Date.now() - t0 > timeoutMs) { console.log(`ещё заняты: ${busy.map((a) => a.label).join(', ')}`); return list; }
    await sleep(2000);
  }
};
let list = await settle(300_000);
console.log('\n— после проверки сессий —');
for (const c of created) console.log(`  ${summarize(list.find((a) => a.id === c.id))}`);

// sync everything active
const active = list.filter((a) => a.status === 'active');
for (const a of active) { try { await api('POST', `/api/accounts/${a.id}/sync`); } catch (e) { console.log(`sync ${a.label}: ${e.message}`); } }
list = await settle(600_000);
console.log('\n— после синхронизации —');
for (const c of created) console.log(`  ${summarize(list.find((a) => a.id === c.id))}`);

const ads = await api('GET', '/api/ad-accounts');
console.log(`\nрекламных кабинетов в базе: ${ads.items.length}`);
for (const it of ads.items.slice(0, 20)) {
  console.log(`  ${it.name} (${it.id}) ${it.currency} ${it.state} кампаний=${it.campaigns.total} расход=${it.metrics.spend} причины=${it.reasons.map((r) => r.text).slice(0, 2).join(',')}`);
}
const dash = await api('GET', '/api/dashboard');
console.log(`\nсводка: логины=${JSON.stringify(dash.accounts.byStatus)} кабинеты=${JSON.stringify(dash.adAccounts)} кампании=${JSON.stringify(dash.campaigns)} расход=${JSON.stringify(dash.spend)}`);
