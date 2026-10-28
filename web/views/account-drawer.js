// Right-hand drawer with the full login card: profile, ad accounts, journal, session.
import { h, toast, fmtTime, download, uid } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { api } from '../lib/api.js';
import { accounts, on, upsertAccount, canEdit, isOwner } from '../lib/store.js';
import { openDrawer, tabs, alertBox, confirmDialog, errorState, loadingBlock, emptyState, reportError } from '../lib/ui.js';
import { field, textInput, textArea, passwordField, tagInput, switchField } from '../lib/forms.js';
import { accountStatusChip, adStateChip, levelChip, pill, spinner, ACCOUNT_STATUS, BUSY_LABEL } from '../lib/status.js';
import { moneyParts, num, relTime, fmtDateTime } from '../lib/format.js';
import { loginAccount, checkAccount, syncAccount, cancelAccount, deleteAccount } from './account-actions.js';
import { openCodeDialog } from './account-code.js';
import { openBrowserDialog } from './browser-dialog.js';
import { openCampaignsDrawer } from './campaigns-drawer.js';

const PROXY_RE = /^(https?|socks[45]h?):\/\/\S+$/i;
const drawers = new Map();

export function openAccountDrawer(id, { tab = 'profile' } = {}) {
  if (drawers.get(id)?.open) return drawers.get(id);
  const edit = canEdit();
  const first = accounts.byId.get(id);
  let data = null, prevBusy = first?.busy ?? null;
  const live = () => accounts.byId.get(id) ?? data?.account ?? first;

  const headSlot = h('div', { class: 'drawer-status' });
  const body = h('div', { class: 'stack' }, loadingBlock());
  const drawer = openDrawer({
    title: first?.label ?? 'Аккаунт', subtitle: first?.login, width: 740, headExtra: headSlot, body,
    onClose: () => { off(); drawers.delete(id); }
  });
  drawers.set(id, drawer);

  /* ----- header + quick actions ----- */
  const actions = h('div', { class: 'drawer-actions' });
  function paintHead() {
    const a = live();
    if (!a) return;
    drawer.setTitle(a.label || a.login);
    drawer.setSubtitle(a.login);
    headSlot.replaceChildren(accountStatusChip(a), a.busy && !ACCOUNT_STATUS[a.status]?.spin ? h('span', { class: 'busy-tag' }, spinner(), BUSY_LABEL[a.busy] ?? a.busy) : null);
  }
  function paintActions() {
    const a = live();
    if (!a || !edit) return;
    const btn = (label, glyph, onClick, { disabled, cls = '', title } = {}) => h('button', { class: `btn sm ${cls}`, type: 'button', disabled, title, onclick: onClick }, icon(glyph, 14), label);
    actions.replaceChildren(
      a.waitingFor === 'code' ? btn('Ввести код', 'mail', () => openCodeDialog(a), { cls: 'cta pulse' }) : null,
      btn('Войти', 'log-in', () => loginAccount(a), { disabled: !!a.busy || !a.hasPassword || a.status === 'disabled', title: a.hasPassword ? 'Войти по паролю' : 'Нет сохранённого пароля' }),
      btn('Проверить', 'shield', () => checkAccount(a), { disabled: !!a.busy || !a.hasSession || a.status === 'disabled', title: a.hasSession ? 'Проверить сессию' : 'Нет сохранённой сессии' }),
      btn('Синхронизировать', 'refresh', () => syncAccount(a), { disabled: !!a.busy || a.status !== 'active' }),
      btn('Браузер', 'monitor', () => openBrowserDialog(a)),
      a.busy === 'login' ? btn('Отмена входа', 'x', () => cancelAccount(a), { cls: 'danger' }) : null);
  }

  /* ----- tabs ----- */
  const adsBox = h('div'), eventsBox = h('div');
  let tabsApi = null;
  function paintAds() {
    const list = data.adAccounts;
    tabsApi?.setBadge('ads', list.length || '');
    if (!list.length) { adsBox.replaceChildren(emptyState({ glyph: 'building', title: 'Кабинетов пока нет', text: 'Они появятся после успешной синхронизации активного логина.' })); return; }
    adsBox.replaceChildren(h('div', { class: 'table-box' }, h('table', { class: 'dtable plain clickable' },
      h('thead', null, h('tr', null, ['Кабинет', 'BC', 'Статус', 'Кампании', 'Расход 7д'].map((t, i) => h('th', { class: i > 2 ? 'num' : '' }, t)))),
      h('tbody', null, list.map((x) => h('tr', { tabindex: '0', onclick: () => openCampaignsDrawer({ accountId: x.accountId, advertiserId: x.id, name: x.name }), onkeydown: (e) => { if (e.key === 'Enter') openCampaignsDrawer({ accountId: x.accountId, advertiserId: x.id, name: x.name }); } },
        h('td', null, h('div', { class: 'cell2' }, h('b', { class: 'ellipsis' }, x.name), h('span', { class: 'muted small mono' }, x.id))),
        h('td', { class: 'ellipsis', title: x.bcName }, x.bcName || '—'),
        h('td', null, adStateChip(x.state)),
        h('td', { class: 'num' }, `${num(x.campaigns.working)} / ${num(x.campaigns.total)}`),
        h('td', { class: 'num' }, x.metrics.spend ? `${num(x.metrics.spend, 2)} ${x.currency}` : '—')))))));
  }
  function paintEvents() {
    const list = data.events;
    tabsApi?.setBadge('events', list.length || '');
    eventsBox.replaceChildren(list.length ? h('div', { class: 'log' }, list.map((e) =>
      h('div', { class: 'log-row' }, h('time', { class: 'mono muted', title: fmtDateTime(e.ts) }, fmtTime(e.ts)), levelChip(e.level), h('span', { class: 'pill sm' }, e.kind),
        h('span', { class: 'log-msg' }, e.message, e.user ? h('span', { class: 'muted' }, ` · ${e.user}`) : null)))) : emptyState({ glyph: 'list', title: 'Событий нет' }));
  }

  function profileTab() {
    const a = data.account;
    const clientList = uid('cl');
    const label = textInput({ value: a.label, disabled: !edit });
    const login = textInput({ value: a.login, disabled: !edit });
    const pw = passwordField({ placeholder: a.hasPassword ? 'не менять' : 'пароль не сохранён', autocomplete: 'new-password' });
    const proxy = textInput({ class: 'input mono', placeholder: 'не менять · http://user:pass@host:port', disabled: !edit });
    const proxyInfo = h('span');
    const proxyBtn = h('button', { class: 'linklike', type: 'button', onclick: () => { clearProxy = !clearProxy; proxy.value = ''; paintProxy(); dirty(); } });
    let clearProxy = false;
    const paintProxy = () => {
      const cur = data.account.proxy;
      proxy.disabled = !edit || clearProxy;
      proxyInfo.replaceChildren(clearProxy ? 'Прокси будет удалён при сохранении. ' : cur ? ['Сейчас: ', h('code', null, cur), '. '] : 'Прокси не задан. ');
      proxyBtn.textContent = clearProxy ? 'Отменить удаление' : 'Убрать прокси';
      proxyBtn.hidden = !edit || !cur;
    };
    const client = textInput({ value: a.client, list: clientList, disabled: !edit });
    const tags = tagInput({ value: a.tags, suggestions: accounts.tags, onChange: () => dirty() });
    const notes = textArea({ value: a.notes, rows: 3, disabled: !edit });
    const off2 = switchField({ label: 'Отключён', hint: 'Пропускается автосинхронизацией и массовыми действиями', checked: a.status === 'disabled', disabled: !edit, onChange: () => dirty() });
    const error = h('div');
    const save = h('button', { class: 'btn primary', type: 'submit', disabled: true }, icon('check', 15), 'Сохранить');
    const dirtyNote = h('span', { class: 'muted small' });

    const diff = () => {
      const base = data.account, patch = {};
      if (label.value.trim() !== base.label) patch.label = label.value.trim();
      if (login.value.trim() !== base.login) patch.login = login.value.trim();
      if (pw.input.value) patch.password = pw.input.value;
      if (clearProxy) patch.proxy = ''; else if (proxy.value.trim()) patch.proxy = proxy.value.trim();
      const nextTags = tags.value;
      if (JSON.stringify(nextTags) !== JSON.stringify(base.tags)) patch.tags = nextTags;
      if (client.value.trim() !== base.client) patch.client = client.value.trim();
      if (notes.value !== base.notes) patch.notes = notes.value;
      if (off2.input.checked !== (base.status === 'disabled')) patch.disabled = off2.input.checked;
      return patch;
    };
    function dirty() {
      const n = Object.keys(diff()).length;
      save.disabled = !n;
      dirtyNote.textContent = n ? 'Есть несохранённые изменения' : '';
    }
    const form = h('form', { class: 'stack', novalidate: true, oninput: dirty, onsubmit: async (e) => {
      e.preventDefault();
      if (!edit) return;
      const patch = diff();
      if (!Object.keys(patch).length) return;
      if ('login' in patch && !patch.login) { error.replaceChildren(alertBox('err', 'Логин не может быть пустым')); login.focus(); return; }
      if (patch.proxy && !PROXY_RE.test(patch.proxy)) { error.replaceChildren(alertBox('err', 'Прокси: http://user:pass@host:port или socks5://…')); proxy.focus(); return; }
      error.replaceChildren();
      save.disabled = true;
      save.replaceChildren(spinner(), 'Сохраняем…');
      try {
        const next = await api.patch(`/api/accounts/${id}`, patch);
        data.account = next;
        upsertAccount(next);
        pw.input.value = ''; proxy.value = ''; clearProxy = false;
        paintProxy(); paintHead();
        toast('Изменения сохранены', 'ok');
      } catch (err) { if (!err.silent) error.replaceChildren(alertBox('err', err.message)); }
      save.replaceChildren(icon('check', 15), 'Сохранить');
      dirty();
    } },
    h('div', { class: 'grid2' }, field('Название', label), field('Логин', login)),
    h('div', { class: 'grid2' }, field('Пароль', pw.el, { forId: pw.input.id, hint: a.hasPassword ? 'Оставьте пустым, чтобы не менять.' : 'Нужен для входа по паролю.' }), field('Клиент', client)),
    field('Прокси', proxy, { hint: h('span', null, proxyInfo, proxyBtn) }),
    field('Теги', tags.el, { forId: tags.input.id }),
    field('Заметки', notes),
    off2.el,
    h('datalist', { id: clientList }, accounts.clients.map((c) => h('option', { value: c }))),
    error,
    edit ? h('div', { class: 'row' }, save, dirtyNote) : null);
    paintProxy();
    const wrap = h('div', { class: 'stack' },
      h('dl', { class: 'meta-grid' }, ...[
        ['Способ входа', a.method === 'password' ? 'Пароль' : 'Сессия (cookies)'], ['Создан', fmtDateTime(a.createdAt)], ['Последний вход', fmtDateTime(a.lastLoginAt)],
        ['Последняя проверка', fmtDateTime(a.lastCheckAt)], ['Последняя синхр.', fmtDateTime(a.lastSyncAt)], ['Расход 7д', moneyParts(a.spend7d).join(' · ')]
      ].flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v)])),
      a.lastError ? alertBox('warn', h('b', null, 'Последняя ошибка: '), a.lastError) : null,
      form,
      edit ? h('section', { class: 'danger-zone' }, h('div', null, h('b', null, 'Удаление аккаунта'), h('p', { class: 'muted small' }, 'Вместе с кабинетами и журналом. Действие нельзя отменить.')),
        h('button', { class: 'btn danger', type: 'button', onclick: async () => { if (await deleteAccount(live())) drawer.close('deleted'); } }, icon('trash', 15), 'Удалить')) : null);
    return wrap;
  }

  function sessionTab() {
    const a = data.account;
    const cookies = textArea({ rows: 6, class: 'textarea mono', placeholder: 'JSON из Cookie-Editor, cookies.txt или строка Cookie…', disabled: !edit });
    const error = h('div');
    const apply = h('button', { class: 'btn primary', type: 'button', onclick: async () => {
      if (!cookies.value.trim()) { error.replaceChildren(alertBox('err', 'Вставьте cookies')); cookies.focus(); return; }
      error.replaceChildren();
      apply.disabled = true;
      try {
        const next = await api.post(`/api/accounts/${id}/session`, { session: cookies.value.trim(), check: true });
        if (next) { upsertAccount(next); data.account = next; }
        cookies.value = '';
        toast('Cookies заменены, проверяем сессию…', 'ok');
      } catch (err) { if (!err.silent) error.replaceChildren(alertBox('err', err.message)); }
      apply.disabled = false;
    } }, icon('shield', 15), 'Заменить и проверить');
    const exportBtn = h('button', { class: 'btn', type: 'button', disabled: !a.hasSession, onclick: async () => {
      const ok = await confirmDialog({ title: 'Экспортировать cookies?', confirmLabel: 'Скачать', text: 'Файл даёт полный доступ к аккаунту TikTok. Экспорт записывается в журнал. Храните файл безопасно.' });
      if (!ok) return;
      try {
        const out = await api.get(`/api/accounts/${id}/session/export`);
        download(`zaliv-session-${live().login.replace(/[^\w.-]+/g, '_')}.json`, JSON.stringify(out, null, 2), 'application/json');
        toast('Cookies выгружены (запись добавлена в журнал)', 'ok');
      } catch (err) { reportError(err); }
    } }, icon('download', 15), 'Экспорт cookies');
    return h('div', { class: 'stack' },
      h('div', { class: 'session-state' }, a.hasSession ? pill('Сессия сохранена', 'ok', { glyph: 'check' }) : pill('Сессии нет', 'muted'),
        a.sessionUpdatedAt ? h('span', { class: 'muted small' }, 'Обновлена: ', relTime(a.sessionUpdatedAt)) : null),
      edit ? [field('Новые cookies', cookies, { hint: 'Принимаются JSON расширений, Playwright storageState, cookies.txt и строка Cookie. После замены сессия проверяется автоматически.' }), error, h('div', { class: 'row' }, apply, isOwner() ? exportBtn : null),
        isOwner() ? null : h('p', { class: 'hint' }, 'Экспорт cookies доступен только владельцу.')] : alertBox('info', 'Режим только для чтения.'));
  }

  async function load() {
    try {
      data = await api.get(`/api/accounts/${id}`);
    } catch (error) {
      if (!drawer.open) return;
      body.replaceChildren(errorState(error.message, () => { body.replaceChildren(loadingBlock()); load(); }));
      return;
    }
    if (!drawer.open) return;
    paintHead(); paintActions();
    tabsApi = tabs([
      { id: 'profile', label: 'Профиль', icon: 'user', render: profileTab },
      { id: 'ads', label: 'Кабинеты', icon: 'building', badge: data.adAccounts.length || '', render: () => { paintAds(); return adsBox; } },
      { id: 'events', label: 'Журнал', icon: 'list', badge: data.events.length || '', render: () => { paintEvents(); return eventsBox; } },
      { id: 'session', label: 'Сессия', icon: 'cookie', render: sessionTab }
    ], { active: tab, label: 'Разделы карточки' });
    body.replaceChildren(actions, tabsApi.el);
  }
  async function reload() {
    try {
      const next = await api.get(`/api/accounts/${id}`);
      if (!drawer.open) return;
      data.adAccounts = next.adAccounts; data.events = next.events;
      if (tabsApi?.panel('ads').dataset.built) paintAds();
      if (tabsApi?.panel('events').dataset.built) paintEvents();
      tabsApi?.setBadge('ads', data.adAccounts.length || ''); tabsApi?.setBadge('events', data.events.length || '');
    } catch { /* the next poll will try again */ }
  }

  const off = on('accounts', () => {
    const a = accounts.byId.get(id);
    if (!a) { drawer.close('gone'); toast('Аккаунт удалён', 'info'); return; }
    paintHead(); paintActions();
    if (prevBusy && !a.busy && data) reload(); // an operation finished: refresh cabinets and journal
    prevBusy = a.busy;
  });
  paintHead();
  load();
  return drawer;
}
