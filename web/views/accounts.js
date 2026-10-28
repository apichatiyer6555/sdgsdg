// «Аккаунты»: the main screen. Filters are client-side over the full list, rows are patched in place on polling.
import { h, fill, debounce, plural } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { accounts, on, canEdit, loadAccounts, accountSig } from '../lib/store.js';
import { chipBar, openMenu, emptyState, errorState, skeletonRows, reportError } from '../lib/ui.js';
import { selectEl, textInput } from '../lib/forms.js';
import { syncHash } from '../lib/router.js';
import { STATUS_FILTERS, ATTENTION_FILTER, STATUS_ORDER } from '../lib/status.js';
import { spinner } from '../lib/status.js';
import { COLUMNS, buildRow, reconcile } from './accounts-rows.js';
import { createBulkBar } from './accounts-bulk.js';
import { loginAccount, checkAccount, syncAccount, deleteAccount } from './account-actions.js';
import { openAddDialog } from './account-add.js';
import { openCodeDialog } from './account-code.js';
import { openBrowserDialog } from './browser-dialog.js';
import { openAccountDrawer } from './account-drawer.js';

export const layout = 'fill';

const selection = new Set(); // survives navigation inside the session
const collator = new Intl.Collator('ru', { numeric: true, sensitivity: 'base' });
const rank = (s) => { const i = STATUS_ORDER.indexOf(s); return i < 0 ? 99 : i; };
const SORTERS = {
  account: (a, b) => collator.compare(a.label || a.login, b.label || b.login),
  status: (a, b) => rank(a.status) - rank(b.status),
  ads: (a, b) => a.adAccountsCount - b.adAccountsCount,
  sync: (a, b) => (Date.parse(a.lastSyncAt) || 0) - (Date.parse(b.lastSyncAt) || 0)
};

export function mount(root, { params }) {
  const edit = canEdit();
  const S = { q: params.get('q') ?? '', status: params.get('status') ?? 'all', tag: params.get('tag') ?? '', client: params.get('client') ?? '', sort: { key: '', dir: 1 } };
  const rowCache = new Map(); // id -> { sig, el }
  let visibleIds = [], lastPicked = null, raf = 0, refreshing = false;

  /* ----- toolbar ----- */
  const search = textInput({ type: 'search', value: S.q, placeholder: 'Поиск: название, логин, клиент, тег', 'aria-label': 'Поиск по аккаунтам', 'data-search': '', autocomplete: 'off' });
  const tagSel = h('span');
  const clientSel = h('span');
  const chips = chipBar({ items: [], value: S.status, label: 'Фильтр по статусу', onChange: (id) => { S.status = id; changed(); } });
  const summary = h('span', { class: 'muted small summary', 'aria-live': 'polite' });
  const refreshBtn = h('button', { class: 'btn', type: 'button', onclick: async () => {
    refreshing = true; paintRefresh();
    try { await loadAccounts(); } catch (error) { reportError(error); } finally { refreshing = false; paintRefresh(); }
  } });
  const paintRefresh = () => { refreshBtn.disabled = refreshing; refreshBtn.replaceChildren(refreshing ? spinner() : icon('refresh', 16), 'Обновить'); };
  paintRefresh();
  const toolbar = h('div', { class: 'toolbar' },
    h('div', { class: 'toolbar-row' },
      h('div', { class: 'search' }, icon('search', 16), search), tagSel, clientSel, h('span', { class: 'spacer' }), summary, refreshBtn,
      edit ? h('button', { class: 'btn primary', type: 'button', onclick: () => openAddDialog() }, icon('plus', 16), 'Добавить') : null),
    chips.el);
  search.addEventListener('input', debounce(() => { S.q = search.value; changed(); }, 160));

  const makeSelect = (slot, key, placeholder, label, values) => {
    const options = [{ value: '', label: placeholder }, ...values.map((v) => ({ value: v, label: v }))];
    if (S[key] && !values.includes(S[key])) options.push({ value: S[key], label: S[key] });
    fill(slot, selectEl({ options, value: S[key], label, className: 'sm', onChange: (v) => { S[key] = v; changed(); } }));
  };

  /* ----- table ----- */
  const checkAll = h('input', { type: 'checkbox', 'aria-label': 'Выбрать все в текущем фильтре', onclick: (e) => {
    if (e.target.checked) for (const id of visibleIds) selection.add(id); else for (const id of visibleIds) selection.delete(id);
    paintSelection();
  } });
  const sortBtn = (col) => {
    const btn = h('button', { class: 'th-btn', type: 'button', onclick: () => {
      S.sort = S.sort.key === col.key ? (S.sort.dir === 1 ? { key: col.key, dir: -1 } : { key: '', dir: 1 }) : { key: col.key, dir: 1 };
      render();
    } }, col.label, h('span', { class: 'sort-ico' }));
    return btn;
  };
  const heads = new Map();
  const thead = h('thead', null, h('tr', null, COLUMNS.map((col) => {
    const th = h('th', { class: `c-${col.key}${col.num ? ' num' : ''}`, scope: 'col' },
      col.key === 'check' ? (edit ? checkAll : null) : col.sort ? sortBtn(col) : col.label);
    heads.set(col.key, th);
    return th;
  })));
  const tbody = h('tbody');
  const table = h('table', { class: 'dtable accounts-table' }, h('colgroup', null, COLUMNS.map((c) => h('col', { style: c.width ? { width: `${c.width}px` } : null }))), thead, tbody);
  const stateBox = h('div', { class: 'state-box' });
  const wrap = h('div', { class: 'table-wrap' }, table, stateBox);
  const bulk = createBulkBar({ selection, clear: () => { selection.clear(); paintSelection(); } });
  root.append(toolbar, wrap, bulk.el);

  /* ----- model ----- */
  const haystack = (a) => `${a.label} ${a.login} ${a.client} ${a.tags.join(' ')} ${a.notes}`.toLowerCase();
  function compute() {
    const q = S.q.trim().toLowerCase();
    const base = accounts.items.filter((a) => (!S.tag || a.tags.includes(S.tag)) && (!S.client || a.client === S.client) && (!q || haystack(a).includes(q)));
    const byStatus = {};
    for (const a of base) byStatus[a.status] = (byStatus[a.status] ?? 0) + 1;
    const filters = S.status === ATTENTION_FILTER.id ? [...STATUS_FILTERS, ATTENTION_FILTER] : STATUS_FILTERS;
    const items = filters.map((f) => ({ id: f.id, label: f.label, tone: f.tone, count: f.statuses ? f.statuses.reduce((n, s) => n + (byStatus[s] ?? 0), 0) : base.length }));
    const active = filters.find((f) => f.id === S.status) ?? STATUS_FILTERS[0];
    const set = active.statuses ? new Set(active.statuses) : null;
    let list = set ? base.filter((a) => set.has(a.status)) : base;
    const sorter = SORTERS[S.sort.key];
    if (sorter) list = [...list].sort((a, b) => sorter(a, b) * S.sort.dir);
    return { list, items, base };
  }

  function rowFor(a) {
    const sig = accountSig(a.id);
    let entry = rowCache.get(a.id);
    if (!entry || entry.sig !== sig) { entry = { sig, el: buildRow(a, edit) }; rowCache.set(a.id, entry); }
    return entry.el;
  }

  function paintSelection() {
    for (const id of [...selection]) if (!accounts.byId.has(id)) selection.delete(id);
    for (const tr of tbody.children) {
      const on = selection.has(Number(tr.dataset.id));
      tr.classList.toggle('selected', on);
      const box = tr.querySelector('input[data-act="select"]');
      if (box && box.checked !== on) box.checked = on;
    }
    const picked = visibleIds.filter((id) => selection.has(id)).length;
    checkAll.checked = picked > 0 && picked === visibleIds.length;
    checkAll.indeterminate = picked > 0 && picked < visibleIds.length;
    wrap.classList.toggle('has-bulk', selection.size > 0);
    bulk.update();
  }

  function render() {
    const { list, items } = compute();
    chips.update(items, S.status);
    makeSelectsIfNeeded();
    visibleIds = list.map((a) => a.id);
    for (const id of rowCache.keys()) if (!accounts.byId.has(id)) rowCache.delete(id);
    for (const [key, th] of heads) {
      if (!SORTERS[key]) continue;
      const on = S.sort.key === key;
      th.setAttribute('aria-sort', on ? (S.sort.dir === 1 ? 'ascending' : 'descending') : 'none');
      th.querySelector('.sort-ico')?.replaceChildren(on ? icon(S.sort.dir === 1 ? 'arrow-up' : 'arrow-down', 12) : '');
    }
    summary.textContent = accounts.loaded ? `Показано ${list.length} из ${accounts.items.length}` : '';

    if (!accounts.loaded) { table.hidden = true; fill(stateBox, accounts.error ? errorState(accounts.error, () => refreshBtn.click()) : skeletonRows(10)); return; }
    if (!accounts.items.length) {
      table.hidden = true;
      fill(stateBox, emptyState({ glyph: 'users', title: 'Пока нет ни одного аккаунта', text: edit ? 'Добавьте первый логин TikTok Ads: по паролю, по cookies-сессии или списком.' : 'Администратор ещё не добавил аккаунты.',
        actions: edit ? [h('button', { class: 'btn primary', type: 'button', onclick: () => openAddDialog() }, icon('plus', 16), 'Добавить аккаунт'), h('button', { class: 'btn', type: 'button', onclick: () => openAddDialog({ tab: 'import' }) }, icon('list', 16), 'Массовый импорт')] : null }));
      return;
    }
    if (!list.length) {
      table.hidden = true;
      fill(stateBox, emptyState({ title: 'Ничего не найдено', text: 'Измените запрос или сбросьте фильтры.', actions: [h('button', { class: 'btn', type: 'button', onclick: resetFilters }, 'Сбросить фильтры')] }));
      return;
    }
    table.hidden = false;
    stateBox.replaceChildren();
    reconcile(tbody, list.map(rowFor));
    paintSelection();
  }

  let metaSig = '';
  function makeSelectsIfNeeded() {
    const sig = JSON.stringify([accounts.tags, accounts.clients, S.tag, S.client]);
    if (sig === metaSig) return;
    metaSig = sig;
    makeSelect(tagSel, 'tag', 'Все теги', 'Фильтр по тегу', accounts.tags);
    makeSelect(clientSel, 'client', 'Все клиенты', 'Фильтр по клиенту', accounts.clients);
  }

  function changed() {
    syncHash('accounts', { q: S.q.trim(), status: S.status, tag: S.tag, client: S.client });
    render();
  }
  function resetFilters() {
    Object.assign(S, { q: '', status: 'all', tag: '', client: '' });
    search.value = '';
    changed();
  }

  /* ----- row events (delegated) ----- */
  const fresh = (a) => accounts.byId.get(a.id) ?? a;
  function rowMenu(a, btn) {
    openMenu(btn, [
      { label: 'Открыть карточку', icon: 'user', onClick: () => openAccountDrawer(a.id) },
      a.waitingFor === 'code' ? { label: 'Ввести код', icon: 'mail', onClick: () => openCodeDialog(fresh(a)) } : null,
      { divider: true },
      { label: 'Войти по паролю', icon: 'log-in', disabled: !a.hasPassword || !!a.busy, onClick: () => loginAccount(fresh(a)) },
      { label: 'Проверить сессию', icon: 'shield', disabled: !a.hasSession || !!a.busy, onClick: () => checkAccount(fresh(a)) },
      { label: 'Синхронизировать', icon: 'refresh', disabled: a.status !== 'active' || !!a.busy, onClick: () => syncAccount(fresh(a)) },
      { label: 'Удалённый браузер', icon: 'monitor', onClick: () => openBrowserDialog(fresh(a)) },
      { divider: true },
      { label: 'Удалить…', icon: 'trash', danger: true, onClick: () => deleteAccount(fresh(a)) }
    ]);
  }
  function pick(id, checked, range) {
    if (range && lastPicked !== null) {
      const from = visibleIds.indexOf(lastPicked), to = visibleIds.indexOf(id);
      if (from >= 0 && to >= 0) for (const k of visibleIds.slice(Math.min(from, to), Math.max(from, to) + 1)) { if (checked) selection.add(k); else selection.delete(k); }
    } else if (checked) selection.add(id); else selection.delete(id);
    lastPicked = id;
    paintSelection();
  }
  tbody.addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-id]');
    if (!tr) return;
    const a = accounts.byId.get(Number(tr.dataset.id));
    if (!a) return;
    const btn = e.target.closest('[data-act]');
    const act = btn?.dataset.act;
    if (act === 'select') { pick(a.id, btn.checked, e.shiftKey); return; }
    if (!act) {
      if (e.target.closest('.c-check')) { pick(a.id, !selection.has(a.id), e.shiftKey); return; }
      if (!e.target.closest('a, button, input, label')) openAccountDrawer(a.id);
      return;
    }
    if (btn.disabled) return;
    ({
      open: () => openAccountDrawer(a.id), login: () => loginAccount(a), check: () => checkAccount(a), sync: () => syncAccount(a),
      browser: () => openBrowserDialog(a), code: () => openCodeDialog(a), more: () => rowMenu(a, btn)
    })[act]?.();
  });

  const schedule = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; render(); }); };
  const offs = [on('accounts', schedule), on('accounts:error', schedule)];
  render();

  return () => {
    offs.forEach((off) => off());
    cancelAnimationFrame(raf);
    rowCache.clear();
  };
}
