// Row rendering for the accounts table. Rows are cached by account signature and patched in place on polling.
import { h } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { num, moneyParts, relTime } from '../lib/format.js';
import { accountStatusChip, ACCOUNT_STATUS, BUSY_LABEL, spinner } from '../lib/status.js';

const COLUMNS = [
  { key: 'check', width: 40 },
  { key: 'account', label: 'Аккаунт', sort: true },
  { key: 'status', label: 'Статус', width: 190, sort: true },
  { key: 'client', label: 'Клиент и теги', width: 160 },
  { key: 'ads', label: 'Кабинеты / BC', width: 90, sort: true, num: true },
  { key: 'spend', label: 'Расход 7д', width: 128, num: true },
  { key: 'sync', label: 'Последняя синхр.', width: 112, sort: true },
  { key: 'proxy', label: 'Прокси', width: 72 },
  { key: 'actions', label: 'Действия', width: 168 }
];
// Viewers get no checkbox column and only an «open» button per row.
export const columnsFor = (edit) => (edit ? COLUMNS : COLUMNS.filter((c) => c.key !== 'check').map((c) => (c.key === 'actions' ? { ...c, label: '', width: 64 } : c)));

const actionBtn = (act, glyph, title, disabled = false) =>
  h('button', { class: 'icon-btn sm', type: 'button', dataset: { act }, title, 'aria-label': title, disabled }, icon(glyph, 16));

function statusCell(a, edit) {
  const meta = ACCOUNT_STATUS[a.status];
  const first = h('div', { class: 'st-line' }, accountStatusChip(a));
  let second;
  if (edit && a.waitingFor === 'code') second = h('button', { class: 'btn xs cta pulse', type: 'button', dataset: { act: 'code' } }, icon('mail', 14), 'Ввести код');
  else if (edit && a.waitingFor === 'manual') second = h('button', { class: 'btn xs cta pulse', type: 'button', dataset: { act: 'browser' } }, icon('monitor', 14), 'Открыть браузер');
  else if (a.busy && !meta?.spin) second = h('div', { class: 'st-detail busy' }, spinner(), BUSY_LABEL[a.busy] ?? a.busy);
  else if (a.status === 'active' && !a.lastError) second = h('div', { class: 'st-detail' }, a.sessionUpdatedAt ? ['Сессия: ', relTime(a.sessionUpdatedAt)] : '');
  else second = h('div', { class: `st-detail ellipsis${a.lastError ? ' warn' : ''}`, title: a.lastError || a.statusDetail }, a.lastError || a.statusDetail || '');
  return h('td', { class: 'c-status' }, h('div', { class: 'cell2' }, first, second));
}

function clientCell(a) {
  const shown = a.tags.slice(0, 3);
  const extra = a.tags.length - shown.length;
  return h('td', { class: 'c-client' }, h('div', { class: 'cell2' },
    h('span', { class: 'ellipsis', title: a.client }, a.client || h('span', { class: 'muted' }, '—')),
    h('div', { class: 'tags-line', title: a.tags.join(', ') }, shown.map((t) => h('span', { class: 'tag' }, t)), extra > 0 ? h('span', { class: 'tag more' }, `+${extra}`) : null)));
}

function actionsCell(a, edit) {
  if (!edit) return h('td', { class: 'c-actions' }, h('div', { class: 'row-actions' }, actionBtn('open', 'chevron-right', 'Открыть карточку')));
  const noLogin = a.busy ? 'Операция уже выполняется' : !a.hasPassword ? 'Нет сохранённого пароля' : a.status === 'disabled' ? 'Аккаунт отключён' : '';
  const noSession = a.busy ? 'Операция уже выполняется' : !a.hasSession ? 'Нет сохранённой сессии' : a.status === 'disabled' ? 'Аккаунт отключён' : '';
  const noSync = a.busy ? 'Операция уже выполняется' : a.status !== 'active' ? 'Синхронизация доступна для активных аккаунтов' : '';
  return h('td', { class: 'c-actions' }, h('div', { class: 'row-actions' },
    actionBtn('login', 'log-in', noLogin || 'Войти по паролю', !!noLogin),
    actionBtn('check', 'shield', noSession || 'Проверить сессию', !!noSession),
    actionBtn('sync', 'refresh', noSync || 'Синхронизировать', !!noSync),
    actionBtn('browser', 'monitor', 'Удалённый браузер'),
    h('button', { class: 'icon-btn sm', type: 'button', dataset: { act: 'more' }, title: 'Другие действия', 'aria-label': 'Другие действия', 'aria-haspopup': 'menu', 'aria-expanded': 'false' }, icon('more', 16))));
}

export function buildRow(a, edit) {
  const spend = moneyParts(a.spend7d);
  return h('tr', { class: a.busy ? 'is-busy' : null, dataset: { id: a.id } },
    edit ? h('td', { class: 'c-check' }, h('input', { type: 'checkbox', dataset: { act: 'select' }, 'aria-label': `Выбрать ${a.label}` })) : null,
    h('td', { class: 'c-account' }, h('div', { class: 'acc' },
      h('span', { class: `acc-ico ${a.method}`, title: a.method === 'password' ? 'Вход по паролю' : 'Вход по сессии (cookies)', role: 'img', 'aria-label': a.method === 'password' ? 'Вход по паролю' : 'Вход по сессии' }, icon(a.method === 'password' ? 'key' : 'cookie', 15)),
      h('div', { class: 'acc-text' },
        h('button', { class: 'link-btn acc-name ellipsis', type: 'button', dataset: { act: 'open' }, title: a.label }, a.label || a.login),
        h('span', { class: 'acc-login ellipsis', title: a.login }, a.login)))),
    statusCell(a, edit),
    clientCell(a),
    h('td', { class: 'c-ads num', title: `Рекламных кабинетов: ${a.adAccountsCount}, Business Center: ${a.bcCount}` }, h('b', null, num(a.adAccountsCount)), h('span', { class: 'muted' }, ` / ${num(a.bcCount)}`)),
    h('td', { class: 'c-spend num', title: spend.join('\n') }, h('div', { class: 'cell2' },
      h('span', { class: 'ellipsis' }, spend[0]), spend.length > 1 ? h('span', { class: 'muted small ellipsis' }, spend.length > 2 ? `${spend[1]} · ещё ${spend.length - 2}` : spend[1]) : null)),
    h('td', { class: 'c-sync' }, relTime(a.lastSyncAt)),
    h('td', { class: 'c-proxy', title: a.proxy || 'Прокси не задан' }, a.proxy ? h('span', { class: 'proxy-on' }, icon('check', 15), h('span', { class: 'sr-only' }, 'Есть')) : h('span', { class: 'muted' }, '—')),
    actionsCell(a, edit));
}
