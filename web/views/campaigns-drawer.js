// Drawer with the campaigns of one ad account (header KPIs, search, status filter, sortable table).
import { h, toast, fill, debounce, copyText } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { api } from '../lib/api.js';
import { canEdit, loadAccounts } from '../lib/store.js';
import { openDrawer, chipBar, loadingBlock, errorState, emptyState, reportError } from '../lib/ui.js';
import { textInput } from '../lib/forms.js';
import { adStateChip, campaignChip, pill, REASON_TONE, spinner } from '../lib/status.js';
import { num, pct, relTime } from '../lib/format.js';
import { sortHead, sortRows } from '../lib/table.js';
import { normAd } from '../lib/normalize.js';

const COLS = [
  { key: 'name', label: 'Кампания', sortable: true, width: 240 },
  { key: 'status', label: 'Статус', sortable: true, width: 128 },
  { key: 'reason', label: 'Причина', sortable: true, width: 190 },
  { key: 'budget', label: 'Бюджет', num: true, sortable: true, width: 92 },
  { key: 'spend', label: 'Расход', num: true, sortable: true, width: 96 },
  { key: 'impressions', label: 'Показы', num: true, sortable: true, width: 92 },
  { key: 'clicks', label: 'Клики', num: true, sortable: true, width: 76 },
  { key: 'conversions', label: 'Конв.', num: true, sortable: true, width: 72 },
  { key: 'ctr', label: 'CTR', num: true, sortable: true, width: 72 },
  { key: 'cpc', label: 'CPC', num: true, sortable: true, width: 72 },
  { key: 'cpa', label: 'CPA', num: true, sortable: true, width: 80 },
  { key: 'cvr', label: 'CVR', num: true, sortable: true, width: 72 }
];
const STATUS_RANK = { issue: 0, working: 1, off: 2 };
const GETTERS = { name: (c) => c.name, status: (c) => STATUS_RANK[c.status] ?? 9, reason: (c) => c.reason || null };
for (const key of ['budget', 'spend', 'impressions', 'clicks', 'conversions', 'ctr', 'cpc', 'cpa', 'cvr']) GETTERS[key] = (c) => c[key];
const FILTERS = [{ id: 'all', label: 'Все' }, { id: 'working', label: 'Работают' }, { id: 'issue', label: 'Проблемы', tone: 'warn' }, { id: 'off', label: 'Выключены' }];

export function openCampaignsDrawer({ accountId, advertiserId, name }) {
  const S = { q: '', status: 'all', sort: { key: 'spend', dir: -1 } };
  let data = null;
  const body = h('div', { class: 'stack' }, loadingBlock());
  const drawer = openDrawer({ title: name || 'Рекламный кабинет', subtitle: advertiserId, width: 1040, body });

  const kpis = h('div', { class: 'kpi-mini-grid' });
  const info = h('div', { class: 'row wrap' });
  const tableBox = h('div', { class: 'table-box tall' });
  const chips = chipBar({ items: FILTERS, value: S.status, label: 'Статус кампаний', onChange: (id) => { S.status = id; paintTable(); } });
  const search = textInput({ type: 'search', placeholder: 'Поиск по названию или ID', 'aria-label': 'Поиск по кампаниям', autocomplete: 'off' });
  search.addEventListener('input', debounce(() => { S.q = search.value; paintTable(); }, 150));
  const head = sortHead(COLS, S.sort, () => paintTable());
  const tbody = h('tbody');
  const table = h('table', { class: 'dtable plain campaigns' }, h('colgroup', null, COLS.map((c) => h('col', { style: { width: `${c.width}px` } }))), head.el, tbody);
  const refresh = h('button', { class: 'btn sm', type: 'button', onclick: () => load(true) }, icon('refresh', 14), 'Обновить');
  const syncBtn = canEdit() ? h('button', { class: 'btn sm', type: 'button', title: 'Обновить данные логина из TikTok', onclick: async () => {
    syncBtn.disabled = true;
    try { await api.post(`/api/accounts/${accountId}/sync`); toast('Синхронизация логина запущена', 'ok'); loadAccounts().catch(() => {}); } catch (error) { reportError(error); }
    syncBtn.disabled = false;
  } }, icon('download', 14), 'Синхронизировать логин') : null;

  function paintHead() {
    const ad = data.adAccount, m = ad.metrics, cur = ad.currency;
    const tile = (label, value, sub) => h('div', { class: 'kpi-mini' }, h('span', null, label), h('b', null, value), sub ? h('small', null, sub) : null);
    const big = (v) => (v >= 100000 ? num(v, 0) : num(v, 2));
    kpis.replaceChildren(tile('Расход 7д', m.spend ? `${big(m.spend)} ${cur}` : '—'), tile('Показы', num(m.impressions)), tile('Клики', num(m.clicks)), tile('Конверсии', num(m.conversions)),
      tile('CTR', pct(m.ctr)), tile('CPC', m.cpc === null ? '—' : `${big(m.cpc)} ${cur}`), tile('CPA', m.cpa === null ? '—' : `${big(m.cpa)} ${cur}`));
    fill(info, adStateChip(ad.state),
      h('span', { class: 'muted small' }, `Кампаний: ${num(ad.campaigns.working)} работают из ${num(ad.campaigns.total)}${ad.campaigns.problem ? `, проблемных: ${num(ad.campaigns.problem)}` : ''}`),
      ...ad.reasons.map((r) => pill(`${r.text} · ${r.count}`, REASON_TONE[r.kind] ?? 'muted', { className: 'sm' })),
      ad.needsTopUp ? pill('Нужно пополнение', 'err', { glyph: 'alert' }) : null,
      h('span', { class: 'spacer' }),
      h('span', { class: 'muted small' }, `${ad.accountLabel} · ${ad.bcName || 'без BC'} · ${ad.country || '—'} · ${ad.currency} · обновлено `, relTime(data.syncedAt ?? ad.syncedAt)));
    drawer.setTitle(ad.name);
    drawer.setSubtitle(`ID ${ad.id}`);
  }

  function paintTable() {
    const list = data.items;
    const counts = { all: list.length, working: 0, issue: 0, off: 0 };
    for (const c of list) counts[c.status] = (counts[c.status] ?? 0) + 1;
    chips.update(FILTERS.map((f) => ({ ...f, count: counts[f.id] ?? 0 })), S.status);
    const q = S.q.trim().toLowerCase();
    const shown = sortRows(list.filter((c) => (S.status === 'all' || c.status === S.status) && (!q || `${c.name} ${c.id}`.toLowerCase().includes(q))), S.sort, GETTERS);
    tbody.replaceChildren(...shown.map((c) => h('tr', null,
      h('td', null, h('div', { class: 'cell2' }, h('b', { class: 'ellipsis', title: c.name }, c.name), h('span', { class: 'muted small mono' }, c.id))),
      h('td', null, campaignChip(c.status)),
      h('td', { class: c.reason ? 'reason' : 'muted', title: c.reason }, c.reason ? h('span', { class: `reason-text ${REASON_TONE[c.reasonKind] ?? ''}` }, c.reason) : '—'),
      h('td', { class: 'num' }, num(c.budget, 2)), h('td', { class: 'num' }, num(c.spend, 2)), h('td', { class: 'num' }, num(c.impressions)), h('td', { class: 'num' }, num(c.clicks)),
      h('td', { class: 'num' }, num(c.conversions)), h('td', { class: 'num' }, pct(c.ctr)), h('td', { class: 'num' }, num(c.cpc, 2)), h('td', { class: 'num' }, num(c.cpa, 2)), h('td', { class: 'num' }, pct(c.cvr)))));
    table.hidden = !shown.length;
    empty.replaceChildren(shown.length ? '' : emptyState({ glyph: list.length ? 'search' : 'chart', title: list.length ? 'Ничего не найдено' : 'Кампаний нет', text: list.length ? 'Измените поиск или фильтр.' : 'В этом кабинете ещё нет кампаний.' }));
  }
  const empty = h('div');
  tableBox.append(table, empty);

  async function load(manual = false) {
    if (manual) { refresh.disabled = true; refresh.replaceChildren(spinner(), 'Обновить'); }
    try {
      const raw = await api.get(`/api/ad-accounts/${accountId}/${advertiserId}/campaigns`);
      if (!drawer.open) return;
      data = { ...raw, adAccount: normAd(raw.adAccount ?? {}), items: raw.items ?? [] };
      if (!body.querySelector('.kpi-mini-grid')) {
        fill(body, h('div', { class: 'row' }, info), kpis,
          h('div', { class: 'row wrap toolbar-inline' }, h('div', { class: 'search' }, icon('search', 16), search), chips.el, h('span', { class: 'spacer' }), syncBtn, refresh,
            h('button', { class: 'btn sm', type: 'button', onclick: async () => { if (await copyText(advertiserId)) toast('ID кабинета скопирован', 'ok'); } }, icon('copy', 14), 'ID')),
          tableBox);
      }
      paintHead(); paintTable();
    } catch (error) {
      if (!drawer.open) return;
      if (!data) fill(body, errorState(error.message, () => { fill(body, loadingBlock()); load(); })); else reportError(error);
    } finally { refresh.disabled = false; refresh.replaceChildren(icon('refresh', 14), 'Обновить'); }
  }
  load();
  return drawer;
}
