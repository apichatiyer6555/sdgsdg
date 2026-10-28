// Dev-only: deterministic in-memory fixtures for the mock server (≈300 logins, ≈400 ad accounts, journal, users).
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CLIENTS = ['Aurora Media', 'BlueFox Agency', 'Cobalt Traffic', 'Delta Growth', 'Echo Performance', 'Falcon Ads', 'Gamma Leads', 'Helios Group', 'Ivy Commerce', 'Juno Studio', 'Kappa Digital', 'Lumen Ads'];
const TAGS = ['nutra', 'gambling', 'crypto', 'ecom', 'vip', 'warm', 'batch-oct', 'usd', 'eur', 'trusted'];
const GEOS = [['US', 'USD'], ['DE', 'EUR'], ['PL', 'PLN'], ['UA', 'UAH'], ['KZ', 'KZT'], ['TR', 'TRY'], ['BR', 'BRL'], ['IT', 'EUR'], ['ES', 'EUR'], ['GB', 'USD']];
const OFFERS = ['Nutra', 'Shop', 'Crypto', 'App', 'Lead-gen', 'Casino', 'Edu', 'Beauty'];
const ERRORS = ['Таймаут при загрузке ads.tiktok.com', 'Прокси не отвечает (ETIMEDOUT)', 'Аккаунт ограничен TikTok', 'TikTok вернул неожиданную страницу'];
const DETAIL = {
  active: 'Сессия действительна', new: 'Сессии ещё нет', logging_in: 'Открываю страницу входа TikTok…',
  need_code: 'TikTok отправил код на почту аккаунта', need_manual: 'Показана капча — решите её в удалённом браузере',
  checking: 'Проверяю сессию…', session_expired: 'Cookies больше не действуют', bad_credentials: 'TikTok: неверный логин или пароль', disabled: 'Отключён оператором'
};
const REASONS = [
  ['Недостаточно средств', 'balance'], ['Закончился бюджет', 'budget'], ['Отклонено', 'rejected'], ['На модерации', 'review'],
  ['Расписание завершено', 'schedule'], ['Кампания выключена', 'off']
];

const iso = (ms) => new Date(ms).toISOString();
const pick = (r, list) => list[Math.floor(r() * list.length)];
const int = (r, lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
const digits = (r, n) => Array.from({ length: n }, () => int(r, 0, 9)).join('');

export function maskProxy(proxy) {
  const v = String(proxy ?? '').trim();
  return v.replace(/^([a-z0-9]+:\/\/[^:@/]+):[^@/]*@/i, '$1:********@');
}

function statusPlan(r) {
  const plan = { active: 188, session_expired: 24, bad_credentials: 8, error: 12, disabled: 15, new: 30, need_code: 5, need_manual: 3, logging_in: 3, checking: 3, syncing: 9 };
  const list = Object.entries(plan).flatMap(([status, n]) => Array(n).fill(status));
  for (let i = list.length - 1; i > 0; i -= 1) { const j = Math.floor(r() * (i + 1)); [list[i], list[j]] = [list[j], list[i]]; }
  return list;
}

export function createDb() {
  const r = rng(20261028);
  const now = Date.now();
  const db = { accounts: [], adAccounts: [], journal: [], users: [], sessions: new Map(), nextAccountId: 1, nextJournalId: 1, nextUserId: 1, settings: { autoSyncEnabled: true, syncIntervalMin: 60 }, startedAt: now, lastSyncRunAt: now - 25 * 60000 };

  db.users.push(
    { id: db.nextUserId++, login: 'admin', password: 'admin-password-1', role: 'owner', mustChangePassword: true, disabled: false, createdAt: iso(now - 80 * 864e5), lastLoginAt: null },
    { id: db.nextUserId++, login: 'manager', password: 'manager-password-1', role: 'admin', mustChangePassword: false, disabled: false, createdAt: iso(now - 40 * 864e5), lastLoginAt: iso(now - 3 * 3600e3) },
    { id: db.nextUserId++, login: 'viewer', password: 'viewer-password-1', role: 'viewer', mustChangePassword: false, disabled: false, createdAt: iso(now - 20 * 864e5), lastLoginAt: iso(now - 864e5) },
    { id: db.nextUserId++, login: 'ex-buyer', password: 'ex-buyer-password-1', role: 'viewer', mustChangePassword: false, disabled: true, createdAt: iso(now - 120 * 864e5), lastLoginAt: iso(now - 60 * 864e5) }
  );

  statusPlan(r).forEach((plan) => {
    const id = db.nextAccountId++;
    const client = r() < 0.85 ? pick(r, CLIENTS) : '';
    const status = plan === 'syncing' ? 'active' : plan;
    const method = ['need_code', 'logging_in', 'bad_credentials', 'need_manual'].includes(status) || r() < 0.72 ? 'password' : 'session';
    const hasSession = ['active', 'session_expired', 'checking'].includes(status) || (status === 'disabled' && r() < 0.5);
    const hasProxy = r() < 0.82;
    const login = r() < 0.8 ? `${pick(r, ['buyer', 'ads', 'media', 'team', 'bm'])}${int(r, 10, 99)}.${(client || 'solo').split(' ')[0].toLowerCase()}@${pick(r, ['mail.test', 'proton.test', 'inbox.test'])}` : `${pick(r, ['tt', 'ads'])}_${digits(r, 6)}`;
    const acc = {
      id, label: `${client || 'Solo'} ${String(id).padStart(3, '0')}`, login, method,
      status, statusDetail: status === 'error' ? pick(r, ERRORS) : DETAIL[status] ?? '',
      busy: null, waitingFor: null,
      hasPassword: method === 'password' || r() < 0.3, hasSession, sessionUpdatedAt: hasSession ? iso(now - int(r, 1, 600) * 3600e3) : null,
      proxy: hasProxy ? maskProxy(`${pick(r, ['http', 'socks5'])}://u${int(r, 100, 999)}:pw${int(r, 1000, 9999)}@${int(r, 20, 200)}.${int(r, 0, 255)}.${int(r, 0, 255)}.${int(r, 1, 254)}:${pick(r, [8080, 3128, 1080, 8000])}`) : '',
      tags: [...new Set(Array.from({ length: int(r, 0, 3) }, () => pick(r, TAGS)))], client, notes: r() < 0.2 ? 'Прогрет, лимит 2 кабинета на BC' : '',
      lastLoginAt: hasSession ? iso(now - int(r, 2, 900) * 3600e3) : null, lastCheckAt: hasSession ? iso(now - int(r, 1, 120) * 3600e3) : null,
      lastSyncAt: status === 'active' ? iso(now - int(r, 1, 300) * 60000) : null, lastError: status === 'error' ? DETAIL.error ?? '' : '',
      createdAt: iso(now - int(r, 1, 90) * 864e5), updatedAt: iso(now - int(r, 1, 3000) * 60000), _x: {}
    };
    if (status === 'error') acc.lastError = acc.statusDetail;
    if (status === 'logging_in') acc.busy = 'login';
    if (status === 'need_code') { acc.busy = 'login'; acc.waitingFor = 'code'; }
    if (status === 'need_manual') { acc.busy = 'login'; acc.waitingFor = 'manual'; acc._x.url = 'https://www.tiktok.com/login/phone-or-email/email'; }
    if (status === 'checking') acc.busy = 'check';
    if (plan === 'syncing') acc.busy = 'sync';
    db.accounts.push(acc);
  });

  // Ad accounts: every login that ever had a session owns 0..4 of them; BCs are shared per client
  const bcPool = new Map();
  for (const acc of db.accounts) {
    if (!acc.hasSession || acc.status === 'new') continue;
    const count = pick(r, [0, 1, 1, 2, 2, 2, 3, 4]);
    const bcs = Array.from({ length: pick(r, [1, 1, 2]) }, (_, i) => {
      const name = `${acc.client || 'Solo'} BC${i ? ` ${i + 1}` : ''}`;
      if (!bcPool.has(name)) bcPool.set(name, { id: `75${digits(r, 17)}`, name });
      return bcPool.get(name);
    });
    for (let i = 0; i < count; i += 1) db.adAccounts.push(makeAdAccount(r, db, acc, pick(r, bcs), now));
  }

  // Journal
  const kinds = [['info', 'login', 'Вход выполнен'], ['info', 'sync', 'Синхронизация завершена'], ['info', 'check', 'Сессия действительна'], ['warn', 'check', 'Сессия истекла'], ['info', 'code', 'Код подтверждения принят'], ['error', 'login', 'Неверный логин или пароль'], ['info', 'audit', 'Добавлен аккаунт'], ['warn', 'sync', 'Часть кабинетов не загружена'], ['error', 'sync', 'Ошибка синхронизации: таймаут']];
  for (let i = 0; i < 320; i += 1) {
    const acc = pick(r, db.accounts);
    const [level, kind, message] = pick(r, kinds);
    db.journal.push({ id: db.nextJournalId++, ts: iso(now - (320 - i) * int(r, 2, 9) * 60000), level, kind, accountId: acc.id, accountLabel: acc.label, user: kind === 'audit' || r() < 0.3 ? pick(r, ['admin', 'manager']) : '', message });
  }
  return db;
}

function makeAdAccount(r, db, acc, bc, now) {
  const [country, currency] = pick(r, GEOS);
  const roll = r();
  const state = roll < 0.55 ? 'delivering' : roll < 0.70 ? 'issue' : roll < 0.80 ? 'paused' : roll < 0.90 ? 'empty' : roll < 0.95 ? 'error' : 'unknown';
  const total = state === 'empty' || state === 'error' || state === 'unknown' ? 0 : int(r, 1, 18);
  const working = state === 'delivering' ? int(r, 1, total) : 0;
  const problem = state === 'issue' ? int(r, 1, total) : state === 'delivering' ? int(r, 0, total - working) : 0;
  const scale = { USD: 1, EUR: 0.9, PLN: 4, UAH: 40, KZT: 480, TRY: 33, BRL: 5 }[currency];
  const spend = state === 'delivering' ? Math.round(r() * 3000 * scale * 100) / 100 : state === 'issue' ? Math.round(r() * 300 * scale * 100) / 100 : 0;
  const impressions = Math.round(spend * int(r, 300, 900) / scale);
  const clicks = Math.round(impressions * (0.006 + r() * 0.02));
  const conversions = Math.round(clicks * (0.02 + r() * 0.08));
  const reasons = state === 'issue' ? Array.from({ length: int(r, 1, 3) }, () => pick(r, REASONS)).filter((x, i, a) => a.findIndex((y) => y[0] === x[0]) === i).map(([text, kind]) => ({ text, kind, count: int(r, 1, Math.max(1, problem)) })) : [];
  return {
    accountId: acc.id, accountLabel: acc.label, id: `7${digits(r, 18)}`, name: `${pick(r, OFFERS)} ${country} ${String(int(r, 1, 99)).padStart(2, '0')}`, country, currency,
    status: state === 'error' ? null : 1, bcId: bc.id, bcName: bc.name, state,
    campaigns: { total, loaded: total, working, enabled: working + problem, problem },
    metrics: { spend, impressions, clicks, conversions, ctr: impressions ? clicks / impressions * 100 : null, cpc: clicks ? spend / clicks : null, cpa: conversions ? spend / conversions : null },
    reasons, needsTopUp: reasons.some((x) => x.kind === 'balance'),
    error: state === 'error' ? 'Нет доступа к кабинету (код 40002)' : '', syncedAt: iso(now - int(r, 1, 400) * 60000)
  };
}

// Campaigns are generated from the ad account so that counts always match.
export function makeCampaigns(ad) {
  const r = rng(Number(String(ad.id).slice(-8)) || 1);
  const out = [];
  const names = ['Prospecting', 'Retargeting', 'Lookalike', 'Broad', 'Creative test', 'Scale', 'Winners', 'Hook A/B'];
  for (let i = 0; i < ad.campaigns.total; i += 1) {
    const status = i < ad.campaigns.working ? 'working' : i < ad.campaigns.working + ad.campaigns.problem ? 'issue' : 'off';
    const [reason, reasonKind] = status === 'issue' ? ad.reasons[i % Math.max(1, ad.reasons.length)] ? [ad.reasons[i % ad.reasons.length].text, ad.reasons[i % ad.reasons.length].kind] : ['Нет доставки', 'other'] : ['', ''];
    const spend = status === 'working' ? Math.round(r() * 500 * 100) / 100 : status === 'issue' ? Math.round(r() * 40 * 100) / 100 : 0;
    const impressions = Math.round(spend * int(r, 300, 900));
    const clicks = Math.round(impressions * (0.006 + r() * 0.02));
    const conversions = Math.round(clicks * (0.02 + r() * 0.08));
    out.push({
      id: `18${digits(r, 16)}`, name: `${pick(r, names)} · ${ad.country} · ${i + 1}`, status, enabled: status !== 'off', reason, reasonKind,
      budget: pick(r, [20, 50, 100, 250, 500]), spend, impressions, clicks, conversions,
      ctr: impressions ? clicks / impressions * 100 : null, cpc: clicks ? spend / clicks : null, cpm: impressions ? spend / impressions * 1000 : null,
      cpa: conversions ? spend / conversions : null, cvr: clicks ? conversions / clicks * 100 : null
    });
  }
  return out;
}
