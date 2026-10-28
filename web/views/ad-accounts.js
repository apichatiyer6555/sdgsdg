// «Рекламные кабинеты»: all advertiser accounts found under every login, with filters, sorting, totals and CSV export.
import { h, fill, debounce, copyText, toast, download, plural } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { api } from '../lib/api.js';
import { chipBar, emptyState, errorState, skeletonRows, reportError } from '../lib/ui.js';
import { selectEl, textInput } from '../lib/forms.js';
import { syncHash } from '../lib/router.js';
import { AD_FILTERS, AD_STATE, AD_STATE_ORDER, REASON_TONE, adStateChip, pill, spinner } from '../lib/status.js';
import { num, pct, moneyParts, relTime, toCsv } from '../lib/format.js';
import { sortHead, sortRows } from '../lib/table.js';
import { normAd } from '../lib/normalize.js';
import { createVirtualBody } from '../lib/vtable.js';
import { openCampaignsDrawer } from './campaigns-drawer.js';

export const layout = 'fill';
const ROW_H = 60; // keep in sync with `.ads-table td { height }`

const COLS = [
  { key: 'name', label: 'Кабинет', sortable: true, width: 236 },
  { key: 'bc', label: 'BC', sortable: true, width: 150 },
  { key: 'login', label: 'Логин', sortable: true, width: 150 },
  { key: 'state', label: 'Статус', sortable: true, width: 150 },
  { key: 'campaigns', label: 'Кампании', num: true, sortable: true, width: 116, title: 'Работают / всего, проблемных' },
  { key: 'spend', label: 'Расход 7д', num: true, sortable: true, width: 128 },
  { key: 'impressions', label: 'Показы', num: true, sortable: true, width: 100 },
  { key: 'clicks', label: 'Клики', num: true, sortable: true, width: 86 },
  { key: 'conversions', label: 'Конв.', num: true, sortable: true, width: 78 },
  { key: 'ctr', label: 'CTR', num: true, sortable: true, width: 76 },
  { key: 'cpa', label: 'CPA', num: true, sortable: true, width: 92 },
  { key: 'reasons', label: 'Причины', width: 236 },
  { key: 'updated', label: 'Обновлено', sortable: true, width: 116 }
];
const GETTERS = {
  name: (x) => x.name, bc: (x) => x.bcName || null, login: (x) => x.accountLabel, state: (x) => AD_STATE_ORDER.indexOf(x.state),
  campaigns: (x) => x.campaigns.total, spend: (x) => x.metrics.spend, impressions: (x) => x.metrics.impressions, clicks: (x) => x.metrics.clicks,
  conversions: (x) => x.metrics.conversions, ctr: (x) => x.metrics.ctr, cpa: (x) => x.metrics.cpa, updated: (x) => Date.parse(x.syncedAt) || null
};
const CSV_COLS = [
  { title: 'Кабинет', value: (x) => x.name }, { title: 'ID кабинета', value: (x) => x.id }, { title: 'BC', value: (x) => x.bcName }, { title: 'ID BC', value: (x) => x.bcId },
  { title: 'Логин', value: (x) => x.accountLabel }, { title: 'Страна', value: (x) => x.country }, { title: 'Валюта', value: (x) => x.currency },
  { title: 'Статус', value: (x) => AD_STATE[x.state]?.label ?? x.state },
  { title: 'Кампаний всего', value: (x) => x.campaigns.total }, { title: 'Работают', value: (x) => x.campaigns.working }, { title: 'Проблемных', value: (x) => x.campaigns.problem },
  { title: 'Расход 7д', value: (x) => x.metrics.spend }, { title: 'Показы', value: (x) => x.metrics.impressions }, { title: 'Клики', value: (x) => x.metrics.clicks },
  { title: 'Конверсии', value: (x) => x.metrics.conversions }, { title: 'CTR, %', value: (x) => x.metrics.ctr }, { title: 'CPC', value: (x) => x.metrics.cpc }, { title: 'CPA', value: (x) => x.metrics.cpa },
  { title: 'Причины', value: (x) => x.reasons.map((r) => `${r.text} (${r.count})`).join('; ') }, { title: 'Нужно пополнение', value: (x) => (x.needsTopUp ? 'да' : 'нет') },
  { title: 'Ошибка', value: (x) => x.error }, { title: 'Обновлено', value: (x) => x.syncedAt }
];

export function mount(root, { params }) {
  const S = { q: params.get('q') ?? '', state: params.get('state') ?? 'all', accountId: params.get('accountId') ?? '', bcId: params.get('bcId') ?? '', currency: params.get('currency') ?? '', sort: { key: 'state', dir: 1 } };
  let data = null, error = '', alive = true, timer = 0, sig = '', refreshing = false, shown = [], selectsFor = null;
  const byKey = new Map();

  const search = textInput({ type: 'search', value: S.q, placeholder: 'Поиск: кабинет, ID, BC, логин', 'aria-label': 'Поиск по кабинетам', 'data-search': '', autocomplete: 'off' });
  const loginSlot = h('span'), bcSlot = h('span'), curSlot = h('span');
  const chips = chipBar({ items: AD_FILTERS, value: S.state, label: 'Фильтр по состоянию', onChange: (id) => { S.state = id; changed(); } });
  const totalsLine = h('div', { class: 'totals', 'aria-live': 'polite' });
  const csvBtn = h('button', { class: 'btn', type: 'button', disabled: true, onclick: exportCsv }, icon('download', 16), 'CSV');
  const refreshBtn = h('button', { class: 'btn', type: 'button', onclick: () => load(true) });
  const paintRefresh = () => { refreshBtn.disabled = refreshing; refreshBtn.replaceChildren(refreshing ? spinner() : icon('refresh', 16), 'Обновить'); };
  paintRefresh();
  search.addEventListener('input', debounce(() => { if (alive) { S.q = search.value; changed(); } }, 160));
  root.append(h('div', { class: 'toolbar' },
    h('div', { class: 'toolbar-row' }, h('div', { class: 'search' }, icon('search', 16), search), loginSlot, bcSlot, curSlot, h('span', { class: 'spacer' }), csvBtn, refreshBtn),
    chips.el, totalsLine));

  const head = sortHead(COLS, S.sort, () => render(true));
  const tbody = h('tbody');
  const table = h('table', { class: 'dtable ads-table' }, h('colgroup', null, COLS.map((c) => h('col', { style: { width: `${c.width}px` } }))), head.el, tbody);
  const stateBox = h('div', { class: 'state-box' });
  const wrap = h('div', { class: 'table-wrap' }, table, stateBox);
  root.append(wrap);
  const rowCache = new Map();
  const vbody = createVirtualBody({ scroller: wrap, table, tbody, rowHeight: ROW_H, columns: COLS.length, renderRow: (x) => cachedRow(x) });

  const hay = (x) => `${x.name} ${x.id} ${x.bcName} ${x.bcId} ${x.accountLabel}`.toLowerCase();
  function compute() {
    const q = S.q.trim().toLowerCase();
    const base = data.items.filter((x) => (!S.accountId || String(x.accountId) === S.accountId) && (!S.bcId || x.bcId === S.bcId) && (!S.currency || x.currency === S.currency) && (!q || hay(x).includes(q)));
    const counts = { all: base.length, delivering: 0, issue: 0, paused: 0, empty: 0, error: 0 };
    for (const x of base) if (x.state in counts) counts[x.state] += 1;
    const list = S.state === 'all' ? base : base.filter((x) => x.state === S.state);
    const bySpend = sortRows(list, { key: 'spend', dir: -1 }, GETTERS); // secondary order: biggest spend first
    return { list: S.sort.key === 'spend' ? bySpend : sortRows(bySpend, S.sort, GETTERS), counts };
  }

  function option(slot, key, placeholder, label, entries) {
    const opts = [{ value: '', label: placeholder }, ...entries];
    if (S[key] && !entries.some((e) => e.value === S[key])) opts.push({ value: S[key], label: S[key] });
    fill(slot, selectEl({ options: opts, value: S[key], label, className: 'sm', onChange: (v) => { S[key] = v; changed(); } }));
  }
  function paintSelects() {
    const logins = new Map(data.items.map((x) => [String(x.accountId), x.accountLabel]));
    option(loginSlot, 'accountId', 'Все логины', 'Фильтр по логину', [...logins].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label, 'ru', { numeric: true })));
    option(bcSlot, 'bcId', 'Все BC', 'Фильтр по Business Center', [...data.bcs].sort((a, b) => a.name.localeCompare(b.name, 'ru')).map((b) => ({ value: b.id, label: b.name })));
    option(curSlot, 'currency', 'Все валюты', 'Фильтр по валюте', data.currencies.map((c) => ({ value: c, label: c })));
  }

  const keyOf = (x) => `${x.accountId}:${x.id}`;
  function cachedRow(x) {
    const hit = rowCache.get(keyOf(x));
    if (hit?.x === x) return hit.el;
    const el = row(x);
    rowCache.set(keyOf(x), { x, el });
    return el;
  }
  function row(x) {
    const key = keyOf(x);
    const reasons = x.reasons.slice(0, 2).map((r) => pill(r.count > 1 ? `${r.text} ×${r.count}` : r.text, REASON_TONE[r.kind] ?? 'muted', { className: 'sm', title: r.text }));
    if (x.reasons.length > 2) reasons.push(h('span', { class: 'pill sm', title: x.reasons.slice(2).map((r) => r.text).join(', ') }, `+${x.reasons.length - 2}`));
    return h('tr', { dataset: { id: key, key } },
      h('td', { class: 'c-name' }, h('div', { class: 'cell2' },
        h('button', { class: 'link-btn ellipsis strong', type: 'button', dataset: { act: 'open' }, title: x.name }, x.name),
        h('span', { class: 'id-line' }, h('span', { class: 'mono muted ellipsis' }, x.id),
          h('button', { class: 'icon-btn xs', type: 'button', dataset: { act: 'copy' }, title: 'Скопировать ID', 'aria-label': `Скопировать ID ${x.id}` }, icon('copy', 12))))),
      h('td', { class: 'ellipsis', title: `${x.bcName} (${x.bcId})` }, x.bcName || h('span', { class: 'muted' }, '—')),
      h('td', { class: 'ellipsis', title: x.accountLabel }, x.accountLabel),
      h('td', { title: x.error || '' }, adStateChip(x.state)),
      h('td', { class: 'num', title: 'Работают / всего' }, h('b', null, num(x.campaigns.working)), h('span', { class: 'muted' }, ` / ${num(x.campaigns.total)}`),
        x.campaigns.problem ? h('span', { class: 'warn-text', title: 'Проблемных кампаний' }, ` · ${num(x.campaigns.problem)}!`) : null),
      h('td', { class: 'num' }, x.metrics.spend ? `${num(x.metrics.spend, 2)} ${x.currency}` : h('span', { class: 'muted' }, `0 ${x.currency}`)),
      h('td', { class: 'num' }, num(x.metrics.impressions)), h('td', { class: 'num' }, num(x.metrics.clicks)), h('td', { class: 'num' }, num(x.metrics.conversions)),
      h('td', { class: 'num' }, pct(x.metrics.ctr)), h('td', { class: 'num' }, x.metrics.cpa === null ? '—' : num(x.metrics.cpa, 2)),
      h('td', { class: 'c-reasons' }, x.error ? h('span', { class: 'err-text ellipsis', title: x.error }, x.error) : h('div', { class: 'reasons-line' }, x.needsTopUp ? pill('Нужно пополнение', 'err', { glyph: 'alert', className: 'strong-pill' }) : null, reasons.filter((_, i) => !(x.needsTopUp && x.reasons[i]?.kind === 'balance')))),
      h('td', null, relTime(x.syncedAt)));
  }

  function render(resetScroll = false) {
    if (!data) { table.hidden = true; fill(stateBox, error ? errorState(error, () => load(true)) : skeletonRows(10)); return; }
    if (selectsFor !== data) { selectsFor = data; paintSelects(); } // only when data changed: rebuilding drops select focus
    const { list, counts } = compute();
    shown = list;
    chips.update(AD_FILTERS.map((f) => ({ ...f, count: counts[f.id] })), S.state);
    head.paint();
    csvBtn.disabled = !list.length;
    const spend = new Map(), sum = { impressions: 0, clicks: 0, conversions: 0 };
    for (const x of list) {
      if (x.metrics.spend) spend.set(x.currency, (spend.get(x.currency) ?? 0) + x.metrics.spend);
      for (const k of Object.keys(sum)) sum[k] += x.metrics[k] ?? 0;
    }
    const spendParts = moneyParts([...spend].map(([currency, amount]) => ({ currency, amount })));
    fill(totalsLine, h('span', null, 'Кабинетов: ', h('b', null, num(list.length)), list.length !== data.items.length ? ` из ${num(data.items.length)}` : ''),
      h('span', null, 'Расход 7д: ', ...spendParts.flatMap((p, i) => [i ? ' · ' : '', h('b', null, p)])),
      h('span', null, 'Показы: ', h('b', null, num(sum.impressions))), h('span', null, 'Клики: ', h('b', null, num(sum.clicks))), h('span', null, 'Конверсии: ', h('b', null, num(sum.conversions))),
      data.period ? h('span', { class: 'muted' }, `Период: ${data.period.st} — ${data.period.et}`) : null);
    if (!data.items.length) {
      table.hidden = true;
      fill(stateBox, emptyState({ glyph: 'building', title: 'Кабинетов пока нет', text: 'Они появятся после успешной синхронизации активных логинов.', actions: [h('a', { class: 'btn primary', href: '#/accounts' }, 'Перейти к аккаунтам')] }));
      return;
    }
    if (!list.length) {
      table.hidden = true;
      fill(stateBox, emptyState({ title: 'Ничего не найдено', text: 'Измените запрос или сбросьте фильтры.', actions: [h('button', { class: 'btn', type: 'button', onclick: () => { Object.assign(S, { q: '', state: 'all', accountId: '', bcId: '', currency: '' }); search.value = ''; selectsFor = null; changed(); } }, 'Сбросить фильтры')] }));
      return;
    }
    table.hidden = false;
    stateBox.replaceChildren();
    byKey.clear();
    for (const x of list) byKey.set(keyOf(x), x);
    vbody.setItems(list, { keepScroll: !resetScroll });
  }

  function changed() {
    syncHash('ad-accounts', { q: S.q.trim(), state: S.state, accountId: S.accountId, bcId: S.bcId, currency: S.currency });
    render(true);
  }

  function exportCsv() {
    const stamp = new Date().toISOString().slice(0, 10);
    download(`zaliv-kabinety-${stamp}.csv`, toCsv(shown, CSV_COLS), 'text/csv;charset=utf-8');
    toast(`CSV: ${shown.length} ${plural(shown.length, 'кабинет', 'кабинета', 'кабинетов')}`, 'ok');
  }

  tbody.addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-key]');
    const x = tr && byKey.get(tr.dataset.key);
    if (!x) return;
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'copy') { copyText(x.id).then((ok) => toast(ok ? `ID скопирован: ${x.id}` : 'Не удалось скопировать ID', ok ? 'ok' : 'error')); return; }
    if (!act && e.target.closest('a, button, input')) return;
    openCampaignsDrawer({ accountId: x.accountId, advertiserId: x.id, name: x.name });
  });

  async function load(manual = false) {
    clearTimeout(timer);
    if (manual) { refreshing = true; paintRefresh(); }
    try {
      const raw = await api.get('/api/ad-accounts');
      if (!alive) return;
      const next = { ...raw, items: (raw.items ?? []).map(normAd), bcs: raw.bcs ?? [], currencies: raw.currencies ?? [] };
      const nextSig = JSON.stringify(next);
      error = '';
      if (nextSig !== sig || !data) { sig = nextSig; data = next; rowCache.clear(); render(); }
    } catch (err) {
      if (!alive) return;
      if (!data) { error = err.message; render(); } else if (manual) reportError(err);
    } finally {
      refreshing = false;
      if (alive) { paintRefresh(); timer = setTimeout(() => { if (!document.hidden) load(); else timer = setTimeout(() => load(), 5000); }, 60000); }
    }
  }
  render();
  load();
  return () => { alive = false; clearTimeout(timer); vbody.destroy(); };
}
