// The only place that talks to the backend: JSON in/out, CSRF header, uniform error handling.
export class ApiError extends Error {
  constructor(message, { status = 0, code = '', silent = false } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.silent = silent; // already handled globally (login screen shown), views should not toast it
  }
}

let csrf = '';
const hooks = { unauthorized: () => {}, mustChange: () => {} };

export const setCsrf = (token) => { csrf = token || ''; };
export const setAuthHooks = (next) => Object.assign(hooks, next);

function withQuery(path, query) {
  if (!query) return path;
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== null && value !== '') qs.set(key, String(value));
  const text = qs.toString();
  return text ? `${path}${path.includes('?') ? '&' : '?'}${text}` : path;
}

async function request(method, path, { body, query, auth = true, raw = false, retried = false } = {}) {
  const init = { method, credentials: 'same-origin', headers: { accept: raw ? '*/*' : 'application/json' } };
  if (method !== 'GET') init.headers['x-csrf-token'] = csrf;
  if (body !== undefined) { init.headers['content-type'] = 'application/json'; init.body = JSON.stringify(body); }

  let res;
  try { res = await fetch(withQuery(path, query), init); } catch {
    throw new ApiError('Нет связи с сервером. Проверьте подключение.', { code: 'network' });
  }

  if (res.ok) {
    if (raw) return res.blob();
    if (res.status === 204) return null;
    const text = await res.text();
    if (!text) return null;
    try { return JSON.parse(text); } catch { throw new ApiError('Сервер вернул некорректный ответ', { status: res.status, code: 'bad_response' }); }
  }

  let data = null;
  try { data = await res.json(); } catch { /* non-JSON error body */ }
  const code = data?.code ?? '';
  const message = data?.error || (res.status >= 500 ? 'Ошибка сервера. Попробуйте ещё раз.' : `Ошибка запроса (${res.status})`);

  if (res.status === 401 && auth) { hooks.unauthorized(); throw new ApiError(message, { status: 401, code, silent: true }); }
  if (res.status === 403 && code === 'must_change_password') { hooks.mustChange(); throw new ApiError(message, { status: 403, code, silent: true }); }
  if (res.status === 403 && code === 'csrf' && !retried && method !== 'GET') {
    // The token can go stale (server restart): refresh it once and repeat the call.
    try { const me = await request('GET', '/api/auth/me', { auth: false, retried: true }); setCsrf(me?.csrf); } catch { /* the retry reports the real problem */ }
    return request(method, path, { body, query, auth, raw, retried: true });
  }
  throw new ApiError(message, { status: res.status, code });
}

export const api = {
  get: (path, query, opts) => request('GET', path, { query, ...opts }),
  post: (path, body, opts) => request('POST', path, { body, ...opts }),
  put: (path, body, opts) => request('PUT', path, { body, ...opts }),
  patch: (path, body, opts) => request('PATCH', path, { body, ...opts }),
  del: (path, opts) => request('DELETE', path, { ...opts }),
  blob: (path, query) => request('GET', path, { query, raw: true })
};
