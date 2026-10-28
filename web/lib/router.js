// Hash routing helpers: #/accounts?status=need_code
export function routeHref(name, params = {}) {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '' && value !== 'all') qs.set(key, String(value));
  }
  const text = qs.toString();
  return `#/${name}${text ? `?${text}` : ''}`;
}

export function parseHash(hash = location.hash) {
  const raw = hash.replace(/^#\/?/, '');
  const [path, query = ''] = raw.split('?');
  return { name: path, params: new URLSearchParams(query) };
}

export const go = (name, params) => { location.hash = routeHref(name, params); };
// Keeps filters in the URL without adding history entries or re-mounting the view.
export const syncHash = (name, params) => history.replaceState(null, '', routeHref(name, params));
