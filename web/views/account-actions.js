// Operator actions on logins, shared by the table, drawer, dashboard and dialogs.
import { h, toast, plural } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { upsertAccount, removeAccounts, loadAccounts, loadSystem, markStarted } from '../lib/store.js';
import { confirmDialog, reportError } from '../lib/ui.js';

const inflight = new Set();
async function once(key, fn) {
  if (inflight.has(key)) return null;
  inflight.add(key);
  try { return await fn(); } finally { inflight.delete(key); }
}

export const loginAccount = (a) => once(`login:${a.id}`, async () => {
  try {
    const next = await api.post(`/api/accounts/${a.id}/login`);
    if (next) upsertAccount(next);
    markStarted(a.id); // the code dialog opens by itself when TikTok asks for a code
    toast(`Вход запущен: ${a.label}`, 'ok');
    return next;
  } catch (error) { reportError(error); return null; }
});

export const checkAccount = (a) => once(`check:${a.id}`, async () => {
  try {
    const next = await api.post(`/api/accounts/${a.id}/check`);
    if (next) upsertAccount(next);
    toast(`Проверка сессии запущена: ${a.label}`, 'ok');
    return next;
  } catch (error) { reportError(error); return null; }
});

export const syncAccount = (a) => once(`sync:${a.id}`, async () => {
  try {
    const next = await api.post(`/api/accounts/${a.id}/sync`);
    if (next) upsertAccount(next);
    toast(`Синхронизация запущена: ${a.label}`, 'ok');
    return next;
  } catch (error) { reportError(error); return null; }
});

export const cancelAccount = (a) => once(`cancel:${a.id}`, async () => {
  try {
    const next = await api.post(`/api/accounts/${a.id}/cancel`);
    if (next) upsertAccount(next);
    toast(`Операция остановлена: ${a.label}`, 'ok');
    return next;
  } catch (error) { reportError(error); return null; }
});

// Resolves true when the account was deleted.
export async function deleteAccount(a) {
  const sure = await confirmDialog({
    title: 'Удалить аккаунт?', danger: true, confirmLabel: 'Удалить',
    text: [h('b', null, a.label), ` (${a.login}) будет удалён вместе с рекламными кабинетами и журналом. Действие нельзя отменить.`]
  });
  if (!sure) return false;
  try {
    await api.del(`/api/accounts/${a.id}`);
    removeAccounts([a.id]);
    toast(`Аккаунт удалён: ${a.label}`, 'ok');
    return true;
  } catch (error) { reportError(error); return false; }
}

export async function bulkAction(ids, action, value) {
  const body = { ids, action };
  if (value !== undefined) body.value = value;
  const result = await api.post('/api/accounts/bulk', body);
  loadAccounts().catch(() => {});
  return result; // { ok: number[], failed: [{ id, error }] }
}

export const countLabel = (n) => `${n} ${plural(n, 'аккаунт', 'аккаунта', 'аккаунтов')}`;

// «Синхронизировать всё»: queue every active login. Resolves to the queued count (null on error).
export async function syncAll() {
  try {
    const { queued = 0 } = (await api.post('/api/system/sync-all')) ?? {};
    toast(queued ? `В очередь поставлено: ${countLabel(queued)}` : 'Нет активных аккаунтов для синхронизации', queued ? 'ok' : 'info');
    loadAccounts().catch(() => {});
    loadSystem();
    return queued;
  } catch (error) { reportError(error); return null; }
}
