import { HttpError } from './errors.js';

const TIKTOK_SUFFIXES = ['tiktok.com', 'tiktokv.com', 'tiktokcdn.com', 'byteoversea.com', 'ttwstatic.com', 'tiktokglobalshop.com', 'tiktokshop.com'];
const AUTH_LIKE = /sess|sid_|^uid_|passport|tt_chain|ttwid|csrf|odin/i;
const MAX_COOKIES = 400;
const MAX_TEXT = 600_000;

const SAME_SITE = { no_restriction: 'None', none: 'None', lax: 'Lax', strict: 'Strict' };

const hostMatches = (domain, suffix) => {
  const d = String(domain).replace(/^\./, '').toLowerCase();
  const s = String(suffix).replace(/^\./, '').toLowerCase();
  return d === s || d.endsWith(`.${s}`);
};

function normalizeCookie(raw, ctx) {
  if (!raw || typeof raw !== 'object') return null;
  const name = String(raw.name ?? '').trim();
  if (!name) return null;
  const value = raw.value === undefined || raw.value === null ? '' : String(raw.value);
  let domain = String(raw.domain ?? raw.host ?? raw.host_key ?? '').trim();
  if (!domain) domain = ctx.defaultDomain;

  let expires = raw.expires ?? raw.expirationDate ?? raw.expiry ?? raw.expiration ?? -1;
  expires = Number(expires);
  if (raw.session === true || !Number.isFinite(expires) || expires <= 0) expires = -1;
  else if (expires > 1e12) expires = Math.floor(expires / 1000);

  let sameSite = SAME_SITE[String(raw.sameSite ?? raw.same_site ?? '').toLowerCase()];
  let secure = raw.secure === true || raw.secure === 'TRUE' || raw.secure === 1;
  if (sameSite === 'None') secure = true;
  const cookie = {
    name, value, domain, path: String(raw.path || '/'), expires,
    httpOnly: raw.httpOnly === true || raw.httpOnly === 'TRUE' || raw.http_only === true,
    secure
  };
  if (sameSite) cookie.sameSite = sameSite;
  return cookie;
}

function parseNetscape(text) {
  const out = [];
  for (let line of text.split(/\r?\n/)) {
    line = line.trim();
    if (!line) continue;
    let httpOnly = false;
    if (line.startsWith('#HttpOnly_')) { httpOnly = true; line = line.slice('#HttpOnly_'.length); } else if (line.startsWith('#')) continue;
    const cols = line.includes('\t') ? line.split('\t') : line.split(/\s+/);
    if (cols.length < 7) continue;
    const [domain, , path, secure, expiry, name, ...rest] = cols;
    out.push({ domain, path, secure: secure.toUpperCase() === 'TRUE', expires: Number(expiry), name, value: rest.join('\t'), httpOnly });
  }
  return out;
}

function parseHeader(text) {
  const body = text.replace(/^\s*cookie\s*:\s*/i, '');
  const out = [];
  for (const part of body.split(/;|\r?\n/)) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const name = part.slice(0, idx).trim();
    if (!name || /\s/.test(name)) continue;
    out.push({ name, value: part.slice(idx + 1).trim(), secure: true });
  }
  return out;
}

/**
 * Accepts any common cookie export format and returns a Playwright storageState-like object.
 * options.defaultDomain: domain for cookies without one (default ".tiktok.com").
 * options.extraHosts: extra hosts that must be kept (used by tests against a local mock).
 */
export function parseSession(input, options = {}) {
  const defaultDomain = options.defaultDomain || '.tiktok.com';
  const extraHosts = options.extraHosts || [];
  const ctx = { defaultDomain };

  const text = String(input ?? '').replace(/^\uFEFF/, '').trim();
  if (!text) throw new HttpError(400, 'Сессия пустая: вставьте cookies.', 'validation');
  if (text.length > MAX_TEXT) throw new HttpError(400, 'Слишком большой текст сессии.', 'validation');

  let format;
  let list = [];
  let origins = [];

  if (text.startsWith('{') || text.startsWith('[')) {
    let json;
    try { json = JSON.parse(text); } catch { throw new HttpError(400, 'Не удалось разобрать JSON с cookies.', 'validation'); }
    if (Array.isArray(json)) { format = 'json-array'; list = json; } else if (json && Array.isArray(json.cookies)) {
      format = 'storage-state'; list = json.cookies;
      if (Array.isArray(json.origins)) origins = json.origins.filter((o) => o && typeof o.origin === 'string' && Array.isArray(o.localStorage)).slice(0, 20);
    } else if (json && typeof json === 'object' && Object.values(json).every((v) => typeof v === 'string')) {
      format = 'json-map'; list = Object.entries(json).map(([name, value]) => ({ name, value, secure: true }));
    } else throw new HttpError(400, 'Неизвестная структура JSON: нужен массив cookies или {"cookies": [...]}.', 'validation');
  } else if (/^#\s*(Netscape|HTTP Cookie File)/i.test(text) || /^(#HttpOnly_)?\S+\t(TRUE|FALSE)\t/im.test(text)) {
    format = 'netscape'; list = parseNetscape(text);
  } else {
    format = 'header'; list = parseHeader(text);
  }

  const now = Math.floor(Date.now() / 1000);
  const warnings = [];
  const seen = new Map();
  let dropped = 0;
  let expired = 0;
  for (const raw of list.slice(0, MAX_COOKIES * 3)) {
    const cookie = normalizeCookie(raw, ctx);
    if (!cookie) { dropped++; continue; }
    const relevant = TIKTOK_SUFFIXES.some((s) => hostMatches(cookie.domain, s)) || hostMatches(cookie.domain, defaultDomain)
      || extraHosts.some((h) => hostMatches(cookie.domain, h));
    if (!relevant) { dropped++; continue; }
    if (cookie.expires > 0 && cookie.expires < now) { expired++; continue; }
    seen.set(`${cookie.name}|${cookie.domain}|${cookie.path}`, cookie);
  }
  const cookies = [...seen.values()].slice(0, MAX_COOKIES);
  if (!cookies.length) {
    throw new HttpError(400, expired
      ? 'Все cookies в этой сессии уже просрочены. Экспортируйте свежую сессию.'
      : 'Не найдено ни одной cookie для tiktok.com. Проверьте формат (JSON, Netscape или строка Cookie).', 'validation');
  }
  if (dropped) warnings.push(`Пропущено cookies не от TikTok или с ошибками: ${dropped}.`);
  if (expired) warnings.push(`Просроченных cookies отброшено: ${expired}.`);
  if (!cookies.some((c) => AUTH_LIKE.test(c.name))) warnings.push('Не видно cookies авторизации (sessionid / sid_tt и т.п.) — сессия может не сработать.');

  return { cookies, origins, format, warnings, stats: { total: list.length, kept: cookies.length, dropped, expired } };
}

export const emptyState = () => ({ cookies: [], origins: [] });

// Only the fields Playwright accepts; used when re-loading a stored state.
export function toPlaywrightState(state) {
  const s = state && typeof state === 'object' ? state : emptyState();
  return { cookies: Array.isArray(s.cookies) ? s.cookies : [], origins: Array.isArray(s.origins) ? s.origins : [] };
}
