// «Обзор»: KPI tiles (links into filtered lists), attention list, recent events, sync status.
import { h, fill, debounce, fmtTime, plural } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { api } from '../lib/api.js';
import { accounts, on, canEdit } from '../lib/store.js';
import { emptyState, errorState, loadingBlock, reportError } from '../lib/ui.js';
import { routeHref } from '../lib/router.js';
import { ACCOUNT_STATUS, ATTENTION_STATUSES, adStateChip, levelChip, pill, spinner } from '../lib/status.js';
import { num, relTime, fmtDateTime } from '../lib/format.js';
import { syncAll } from './account-actions.js';
import { openAccountDrawer } from './account-drawer.js';
import { openCampaignsDrawer } from './campaigns-drawer.js';
import { openCodeDialog } from './account-code.js';
import { openBrowserDialog } from './browser-dialog.js';

const stat = (label, value, href, tone = '') => h('a', { class: `kpi-stat ${tone}`, href }, h('b', null, num(value)), h('span', null, label));

function kpiCard({ title, glyph, main, href, caption, stats, body }) {
  return h('section', { class: 'card kpi' },
    h('div', { class: 'kpi-title' }, icon(glyph, 16), title),
    main === null ? null : h('a', { class: 'kpi-main', href }, num(main), h('small', null, caption)),
    body ?? h('div', { class: 'kpi-stats' }, stats));
}

function attentionRow(item, edit) {
  const acc = item.kind === 'account' ? accounts.byId.get(item.accountId) : null;
  const meta = ACCOUNT_STATUS[item.state];
  const chip = item.kind === 'account' ? pill(meta?.label ?? item.state, meta?.tone ?? 'muted', { glyph: meta?.glyph, spin: meta?.spin }) : adStateChip(item.state);
  const open = () => (item.kind === 'account' ? openAccountDrawer(item.accountId) : openCampaignsDrawer({ accountId: item.accountId, advertiserId: item.adAccountId, name: item.title }));
  let action = h('button', { class: 'btn sm', type: 'button', onclick: open }, item.kind === 'account' ? 'Открыть' : 'Кампании');
  if (edit && acc && item.state === 'need_code') action = h('button', { class: 'btn sm cta', type: 'button', onclick: () => openCodeDialog(accounts.byId.get(item.accountId) ?? acc) }, icon('mail', 14), 'Ввести код');
  else if (edit && acc && item.state === 'need_manual') action = h('button', { class: 'btn sm cta', type: 'button', onclick: () => openBrowserDialog(accounts.byId.get(item.accountId) ?? acc) }, icon('monitor', 14), 'Браузер');
  return h('li', { class: 'attn-row' },
    h('span', { class: `attn-ico ${item.kind}` }, icon(item.kind === 'account' ? 'user' : 'building', 16)),
    h('div', { class: 'attn-text' }, h('button', { class: 'link-btn ellipsis strong', type: 'button', onclick: open, title: item.title }, item.title), h('span', { class: 'muted small clamp-2', title: item.text }, item.text)),
    chip, action);
}

export function mount(root) {
  let alive = true, sig = '', data = null, syncing = false;
  const box = h('div', { class: 'page-pad' }, loadingBlock());
  root.append(box);
  const edit = canEdit();

  function render() {
    const d = data;
    const by = d.accounts.byStatus ?? {};
    const attentionCount = ATTENTION_STATUSES.reduce((n, s) => n + (by[s] ?? 0), 0);
    const spend = d.spend?.['7d'] ?? [];
    const syncBtn = edit ? h('button', { class: 'btn primary', type: 'button', disabled: syncing, onclick: async () => { syncing = true; render(); await syncAll(); syncing = false; load(); } },
      syncing ? spinner() : icon('refresh', 16), 'Синхронизировать всё') : null;
    const s = d.sync;
    fill(box,
      h('div', { class: 'kpi-grid' },
        kpiCard({ title: 'Логины', glyph: 'users', main: d.accounts.total, href: routeHref('accounts'), caption: 'всего', stats: [
          stat('Активных', by.active ?? 0, routeHref('accounts', { status: 'active' }), 'ok'),
          stat('Требуют внимания', attentionCount, routeHref('accounts', { status: 'attention' }), attentionCount ? 'warn' : ''),
          stat('Нужен код', by.need_code ?? 0, routeHref('accounts', { status: 'need_code' }), by.need_code ? 'warn' : ''),
          stat('Отключены', by.disabled ?? 0, routeHref('accounts', { status: 'disabled' }))] }),
        kpiCard({ title: 'Рекламные кабинеты', glyph: 'building', main: d.adAccounts.total, href: routeHref('ad-accounts'), caption: 'всего', stats: [
          stat('Работают', d.adAccounts.delivering, routeHref('ad-accounts', { state: 'delivering' }), 'ok'), stat('Проблемы', d.adAccounts.issue, routeHref('ad-accounts', { state: 'issue' }), d.adAccounts.issue ? 'warn' : ''),
          stat('Выключены', d.adAccounts.paused, routeHref('ad-accounts', { state: 'paused' }), 'info'), stat('Нет рекламы', d.adAccounts.empty, routeHref('ad-accounts', { state: 'empty' })),
          stat('Ошибка', d.adAccounts.error, routeHref('ad-accounts', { state: 'error' }), d.adAccounts.error ? 'err' : '')] }),
        kpiCard({ title: 'Кампании', glyph: 'activity', main: d.campaigns.total, href: routeHref('ad-accounts'), caption: 'всего', stats: [
          stat('Работают', d.campaigns.working, routeHref('ad-accounts', { state: 'delivering' }), 'ok'), stat('Проблемы', d.campaigns.problem, routeHref('ad-accounts', { state: 'issue' }), d.campaigns.problem ? 'warn' : '')] }),
        kpiCard({ title: 'Расход за 7 дней', glyph: 'dollar', main: null, body: spend.length
          ? h('div', { class: 'spend-list' }, spend.slice(0, 5).map((m) => h('a', { class: 'spend-row', href: routeHref('ad-accounts', { currency: m.currency }), title: `Кабинеты в ${m.currency}` }, h('b', null, num(m.amount, m.amount >= 100000 ? 0 : 2)), h('span', null, m.currency))),
            spend.length > 5 ? h('a', { class: 'small', href: routeHref('ad-accounts') }, `и ещё ${spend.length - 5} ${plural(spend.length - 5, 'валюта', 'валюты', 'валют')} — смотреть все`) : null)
          : h('span', { class: 'muted' }, 'Данных о расходе пока нет') })),
      h('div', { class: 'dash-grid' },
        h('section', { class: 'card attn-card' },
          h('div', { class: 'card-head' }, h('h2', { class: 'card-title' }, icon('alert', 16), 'Требует внимания'), d.attention.length ? h('span', { class: 'pill warn' }, d.attention.length >= 50 ? '50+' : d.attention.length) : null),
          d.attention.length ? h('ul', { class: 'attn-list' }, d.attention.map((i) => attentionRow(i, edit)))
            : emptyState({ glyph: 'check', title: 'Всё в порядке', text: 'Нет логинов и кабинетов, которым нужно внимание оператора.' })),
        h('div', { class: 'dash-side' },
          h('section', { class: 'card' },
            h('div', { class: 'card-head' }, h('h2', { class: 'card-title' }, icon('clock', 16), 'Синхронизация'), s.autoEnabled ? pill('Авто вкл', 'ok', { glyph: 'check' }) : pill('Авто выкл', 'muted', { glyph: 'pause' })),
            h('dl', { class: 'kv-list' },
              h('dt', null, 'Интервал'), h('dd', null, s.autoEnabled ? `каждые ${num(s.intervalMin)} мин` : 'отключена'),
              h('dt', null, 'Последний запуск'), h('dd', null, s.lastRunAt ? relTime(s.lastRunAt) : '—'),
              h('dt', null, 'Следующий'), h('dd', null, s.autoEnabled && s.nextRunAt ? relTime(s.nextRunAt) : '—'),
              h('dt', null, 'Выполняется'), h('dd', null, num(s.running)), h('dt', null, 'В очереди'), h('dd', null, num(s.queued))),
            syncBtn ? h('div', { class: 'card-foot' }, syncBtn) : null),
          h('section', { class: 'card' },
            h('div', { class: 'card-head' }, h('h2', { class: 'card-title' }, icon('list', 16), 'Последние события'), h('a', { class: 'small', href: routeHref('journal') }, 'Весь журнал')),
            d.recentEvents.length ? h('ul', { class: 'event-list' }, d.recentEvents.map((e) => h('li', null,
              h('time', { class: 'mono muted', title: fmtDateTime(e.ts) }, fmtTime(e.ts)), levelChip(e.level),
              h('span', { class: 'event-msg' }, e.accountId ? h('button', { class: 'link-btn strong', type: 'button', onclick: () => openAccountDrawer(e.accountId) }, e.accountLabel) : null, e.accountId ? ' · ' : '', e.message))))
              : emptyState({ glyph: 'list', title: 'Событий пока нет' })))));
  }

  async function load(manual = false) {
    try {
      const raw = await api.get('/api/dashboard');
      if (!alive) return;
      const next = { ...raw, accounts: { byStatus: {}, total: 0, ...raw.accounts }, adAccounts: { total: 0, delivering: 0, issue: 0, paused: 0, empty: 0, error: 0, ...raw.adAccounts },
        campaigns: { total: 0, working: 0, problem: 0, ...raw.campaigns }, attention: raw.attention ?? [], recentEvents: raw.recentEvents ?? [], sync: { running: 0, queued: 0, ...raw.sync } };
      const nextSig = JSON.stringify(next);
      if (nextSig !== sig || !data) { sig = nextSig; data = next; render(); }
    } catch (error) {
      if (!alive) return;
      if (!data) fill(box, errorState(error.message, () => { fill(box, loadingBlock()); load(); })); else if (manual) reportError(error);
    }
  }
  const soon = debounce(() => { if (alive && !document.hidden) load(); }, 900);
  const offs = [on('accounts', soon)];
  const timer = setInterval(() => { if (!document.hidden) load(); }, 20000);
  load();
  return () => { alive = false; clearInterval(timer); soon.cancel(); offs.forEach((off) => off()); };
}
