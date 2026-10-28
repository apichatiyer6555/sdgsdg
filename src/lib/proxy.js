import { badRequest } from './errors.js';

const SCHEMES = new Set(['http', 'https', 'socks5', 'socks4']);

/**
 * Accepts: scheme://user:pass@host:port, user:pass@host:port, host:port, host:port:user:pass.
 * Returns a normalized url string (scheme://[user:pass@]host:port) or '' for empty input.
 */
export function normalizeProxy(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return '';
  let candidate = raw;
  if (!/^[a-z0-9]+:\/\//i.test(candidate)) {
    const parts = candidate.split(':');
    if (!candidate.includes('@') && parts.length === 4) candidate = `http://${parts[2]}:${parts[3]}@${parts[0]}:${parts[1]}`;
    else candidate = `http://${candidate}`;
  }
  let url;
  try { url = new URL(candidate); } catch { throw badRequest('Некорректный прокси. Формат: http://user:pass@host:port'); }
  const scheme = url.protocol.replace(':', '').toLowerCase();
  if (!SCHEMES.has(scheme)) throw badRequest('Поддерживаются прокси http, https, socks5.');
  if (!url.hostname || !url.port) throw badRequest('В прокси должен быть хост и порт: http://host:port');
  if (scheme.startsWith('socks') && (url.username || url.password)) {
    throw badRequest('Chromium не поддерживает SOCKS с логином и паролем — используйте HTTP(S)-прокси.');
  }
  const auth = url.username ? `${url.username}${url.password ? `:${url.password}` : ''}@` : '';
  return `${scheme}://${auth}${url.hostname}:${url.port}`;
}

export function toPlaywrightProxy(stored) {
  if (!stored) return undefined;
  const url = new URL(stored);
  const proxy = { server: `${url.protocol}//${url.host}` };
  if (url.username) proxy.username = decodeURIComponent(url.username);
  if (url.password) proxy.password = decodeURIComponent(url.password);
  return proxy;
}

export function maskProxy(stored) {
  if (!stored) return '';
  try {
    const url = new URL(stored);
    const user = url.username ? `${decodeURIComponent(url.username)}${url.password ? ':***' : ''}@` : '';
    return `${url.protocol}//${user}${url.host}`;
  } catch { return '***'; }
}
