// Shared client state: session, accounts list with adaptive polling, system info, tiny event bus.
import { api } from './api.js';

const listeners = new Map();
export function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
  return () => listeners.get(event)?.delete(fn);
}
export function emit(event, payload) {
  for (const fn of [...(listeners.get(event) ?? [])]) {
    try { fn(payload); } catch (error) { console.error(`listener for "${event}" failed`, error); }
  }
}

/* ---------- session ---------- */
export const session = { user: null };
export const canEdit = () => !!session.user && session.user.role !== 'viewer';
export const isOwner = () => session.user?.role === 'owner';

/* ---------- accounts ---------- */
export const accounts = { items: [], byId: new Map(), tags: [], clients: [], loaded: false, error: '' };
const sigs = new Map();
let metaSig = '';
let loading = null;

export const accountSig = (id) => sigs.get(id) ?? '';

function apply(items, tags, clients) {
  const changed = new Set();
  const next = new Map();
  let orderChanged = items.length !== accounts.items.length;
  items.forEach((a, i) => {
    const sig = JSON.stringify(a);
    next.set(a.id, sig);
    if (sigs.get(a.id) !== sig) changed.add(a.id);
    if (!orderChanged && accounts.items[i]?.id !== a.id) orderChanged = true;
  });
  const removed = [...sigs.keys()].filter((id) => !next.has(id));
  const nextMeta = JSON.stringify([tags, clients]);
  const metaChanged = nextMeta !== metaSig;
  sigs.clear();
  for (const [id, sig] of next) sigs.set(id, sig);
  metaSig = nextMeta;
  Object.assign(accounts, { items, byId: new Map(items.map((a) => [a.id, a])), tags, clients });
  const first = !accounts.loaded;
  accounts.loaded = true;
  if (first || changed.size || removed.length || orderChanged || metaChanged) emit('accounts', { changed, removed, orderChanged, metaChanged });
}

export function loadAccounts() {
  if (loading) return loading;
  loading = api.get('/api/accounts')
    .then((data) => { accounts.error = ''; apply(data.items ?? [], data.tags ?? [], data.clients ?? []); return accounts; })
    .catch((error) => { accounts.error = error.message; emit('accounts:error', error); throw error; })
    .finally(() => { loading = null; schedulePoll(); });
  return loading;
}

// Apply a server response for one account right away (do not wait for the next poll).
export function upsertAccount(account) {
  if (!account || account.id === undefined) return;
  const exists = accounts.byId.has(account.id);
  const items = exists ? accounts.items.map((a) => (a.id === account.id ? account : a)) : [...accounts.items, account];
  apply(items, accounts.tags, accounts.clients);
}
export function removeAccounts(ids) {
  const drop = new Set(ids);
  apply(accounts.items.filter((a) => !drop.has(a.id)), accounts.tags, accounts.clients);
}

/* ---------- logins the operator started from this page (code dialog opens for them) ---------- */
export const started = new Set();
export const markStarted = (id) => { started.add(id); emit('started', id); };

/* ---------- system ---------- */
export const system = { data: null };
export async function loadSystem() {
  try { system.data = await api.get('/api/system'); emit('system', system.data); } catch { /* the sidebar pill just stays stale */ }
}

/* ---------- polling: 2.5 s while something is running / waiting for the operator, otherwise 20 s ---------- */
let polling = false;
let pollTimer = 0;
let sysTimer = 0;

function schedulePoll() {
  clearTimeout(pollTimer);
  if (!polling) return;
  const hot = accounts.items.some((a) => a.busy || a.waitingFor);
  pollTimer = setTimeout(pollTick, hot ? 2500 : 20000);
}
async function pollTick() {
  clearTimeout(pollTimer);
  if (!polling || document.hidden) return; // resumed by visibilitychange
  try { await loadAccounts(); } catch { schedulePoll(); }
}
function sysTick() {
  clearTimeout(sysTimer);
  if (!polling) return;
  if (document.hidden) return;
  loadSystem().finally(() => { if (polling) sysTimer = setTimeout(sysTick, 30000); });
}
function onVisibility() {
  if (document.hidden || !polling) return;
  pollTick();
  sysTick();
}

export function startPolling() {
  if (polling) return;
  polling = true;
  document.addEventListener('visibilitychange', onVisibility);
  pollTick();
  sysTick();
}
export function stopPolling() {
  polling = false;
  clearTimeout(pollTimer);
  clearTimeout(sysTimer);
  document.removeEventListener('visibilitychange', onVisibility);
}

export function resetStore() {
  stopPolling();
  session.user = null;
  sigs.clear();
  metaSig = '';
  Object.assign(accounts, { items: [], byId: new Map(), tags: [], clients: [], loaded: false, error: '' });
  system.data = null;
  started.clear();
}
