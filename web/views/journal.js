// «Журнал»: audit + login / sync events, newest first, paged with `before` / `hasMore`.
import { h, fill, fmtTime } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { api } from '../lib/api.js';
import { accounts } from '../lib/store.js';
import { emptyState, errorState, skeletonRows, reportError } from '../lib/ui.js';
import { selectEl } from '../lib/forms.js';
import { syncHash } from '../lib/router.js';
import { levelChip, spinner } from '../lib/status.js';
import { relTime, fmtDateTime } from '../lib/format.js';
import { openAccountDrawer } from './account-drawer.js';

export const layout = 'fill';

const LEVELS = [{ value: '', label: 'Все уровни' }, { value: 'info', label: 'Инфо' }, { value: 'warn', label: 'Предупреждения' }, { value: 'error', label: 'Ошибки' }];
const PAGE = 100;

export function mount(root, { params }) {
  const S = { level: params.get('level') ?? '', accountId: params.get('accountId') ?? '' };
  let items = [], hasMore = false, loading = false, failed = '', alive = true, seq = 0, timer = 0, rowsSig = '';

  const levelSel = selectEl({ options: LEVELS, value: S.level, label: 'Уровень', className: 'sm', onChange: (v) => { S.level = v; reload(); } });
  const logins = [...accounts.items].sort((a, b) => a.label.localeCompare(b.label, 'ru', { numeric: true }));
  const options = [{ value: '', label: 'Все логины' }, ...logins.map((a) => ({ value: String(a.id), label: a.label }))];
  if (S.accountId && !options.some((o) => o.value === S.accountId)) options.push({ value: S.accountId, label: `Логин №${S.accountId}` });
  const loginSel = selectEl({ options, value: S.accountId, label: 'Логин', className: 'sm', onChange: (v) => { S.accountId = v; reload(); } });
  const refresh = h('button', { class: 'btn', type: 'button', onclick: () => reload(true) });
  const paintRefresh = () => { refresh.disabled = loading; refresh.replaceChildren(loading ? spinner() : icon('refresh', 16), 'Обновить'); };
  const tbody = h('tbody');
  const table = h('table', { class: 'dtable journal-table' },
    h('colgroup', null, [150, 150, 120, 200, 130].map((w) => h('col', { style: { width: `${w}px` } })), h('col')),
    h('thead', null, h('tr', null, ['Время', 'Уровень', 'Тип', 'Логин', 'Пользователь', 'Сообщение'].map((t) => h('th', { scope: 'col' }, t)))), tbody);
  const more = h('div', { class: 'more-box' });
  const stateBox = h('div', { class: 'state-box' });
  const wrap = h('div', { class: 'table-wrap' }, table, more, stateBox);
  root.append(h('div', { class: 'toolbar' }, h('div', { class: 'toolbar-row' }, levelSel, loginSel, h('span', { class: 'spacer' }), refresh)), wrap);

  function render() {
    paintRefresh();
    if (!items.length) {
      rowsSig = '';
      table.hidden = true; more.replaceChildren();
      fill(stateBox, failed ? errorState(failed, () => reload(true)) : loading ? skeletonRows(10) : emptyState({ glyph: 'list', title: 'Событий нет', text: 'Под выбранные фильтры ничего не подошло.' }));
      return;
    }
    table.hidden = false; stateBox.replaceChildren();
    const sig = items.map((e) => e.id).join(',');
    if (sig !== rowsSig) { // do not rebuild rows (and lose focus) when a refresh brought nothing new
      rowsSig = sig;
      tbody.replaceChildren(...items.map((e) => h('tr', null,
        h('td', { class: 'nowrap', title: fmtDateTime(e.ts) }, h('div', { class: 'cell2' }, h('span', { class: 'mono' }, fmtTime(e.ts)), h('small', { class: 'muted' }, relTime(e.ts)))),
        h('td', null, levelChip(e.level)), h('td', null, h('span', { class: 'pill sm' }, e.kind)),
        h('td', { class: 'ellipsis' }, e.accountId ? h('button', { class: 'link-btn ellipsis', type: 'button', title: e.accountLabel, onclick: () => openAccountDrawer(e.accountId) }, e.accountLabel) : h('span', { class: 'muted' }, '—')),
        h('td', { class: 'ellipsis', title: e.user }, e.user || h('span', { class: 'muted' }, 'система')), h('td', { class: 'msg' }, e.message))));
    }
    more.replaceChildren(hasMore ? h('button', { class: 'btn', type: 'button', disabled: loading, onclick: () => load(true) }, loading ? spinner() : icon('chevron', 15), 'Загрузить ещё') : h('span', { class: 'muted small' }, `Показано событий: ${items.length}`));
  }

  async function load(append) {
    const my = ++seq;
    loading = true; failed = '';
    if (items.length) paintRefresh(); else render();
    try {
      const res = await api.get('/api/journal', { limit: PAGE, level: S.level, accountId: S.accountId, before: append && items.length ? items.at(-1).id : '' });
      if (!alive || my !== seq) return;
      items = append ? [...items, ...res.items] : res.items;
      hasMore = !!res.hasMore;
    } catch (error) {
      if (!alive || my !== seq) return;
      if (items.length) reportError(error); else failed = error.message;
    } finally { if (alive && my === seq) { loading = false; render(); } }
  }
  function reload() { syncHash('journal', { level: S.level, accountId: S.accountId }); items = []; load(false); }

  // keep the first page fresh unless the operator already paged down
  timer = setInterval(() => { if (!document.hidden && !loading && items.length <= PAGE) load(false); }, 20000);
  load(false);
  return () => { alive = false; clearInterval(timer); };
}
