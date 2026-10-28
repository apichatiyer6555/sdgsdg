// «Добавить аккаунт»: password / session cookies / bulk import (three tabs in one modal).
import { h, toast, plural, uid } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { api } from '../lib/api.js';
import { accounts, upsertAccount, loadAccounts, markStarted } from '../lib/store.js';
import { openModal, tabs, alertBox } from '../lib/ui.js';
import { field, textInput, textArea, passwordField, tagInput, checkField } from '../lib/forms.js';
import { spinner } from '../lib/status.js';

const PROXY_RE = /^(https?|socks[45]h?):\/\/\S+$/i;
const PROXY_HINT = 'Формат: http://user:pass@host:port или socks5://user:pass@host:port';
const proxyProblem = (v) => (v && !PROXY_RE.test(v) ? PROXY_HINT : '');
const compact = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== '' && v !== undefined && !(Array.isArray(v) && !v.length)));
const codeList = (items) => h('ul', { class: 'hint-list' }, items.map((x) => h('li', null, ...x)));

// Shared client / tags / proxy (+ label, notes) block
function metaFields({ label = false, notes = false } = {}) {
  const clientList = uid('clients');
  const labelInput = label ? textInput({ placeholder: 'По умолчанию — логин' }) : null;
  const client = textInput({ placeholder: 'Название клиента', list: clientList });
  const tags = tagInput({ suggestions: accounts.tags });
  const proxy = textInput({ placeholder: 'http://user:pass@host:port', class: 'input mono', spellcheck: 'false' });
  const notesInput = notes ? textArea({ rows: 2, placeholder: 'Любые заметки по аккаунту', style: { minHeight: '64px' } }) : null;
  return {
    nodes: [
      labelInput ? field('Название', labelInput) : null,
      h('div', { class: 'grid2' }, field('Клиент', client), field('Теги', tags.el, { forId: tags.input.id })),
      field('Прокси', proxy, { hint: PROXY_HINT }),
      notesInput ? field('Заметки', notesInput) : null,
      h('datalist', { id: clientList }, accounts.clients.map((c) => h('option', { value: c })))
    ],
    proxy,
    read: () => compact({ label: labelInput?.value.trim(), client: client.value.trim(), tags: tags.value, proxy: proxy.value.trim(), notes: notesInput?.value.trim() })
  };
}

export function openAddDialog({ tab = 'password' } = {}) {
  let busy = false;
  const submit = h('button', { class: 'btn primary', type: 'submit' });
  const forms = {};

  function paintSubmit(label) {
    submit.disabled = busy;
    submit.replaceChildren(...(busy ? [spinner(), 'Сохраняем…'] : [icon('plus', 15), label]));
  }
  const labels = { password: 'Добавить аккаунт', session: 'Добавить аккаунт', import: 'Импортировать' };
  async function run(tabId, errorSlot, work) {
    if (busy) return;
    errorSlot.replaceChildren();
    busy = true; paintSubmit(labels[tabId]);
    try { await work(); } catch (error) {
      if (!error.silent) errorSlot.replaceChildren(alertBox('err', error.message));
    } finally { busy = false; paintSubmit(labels[tabId]); }
  }
  const invalid = (slot, text, focus) => { slot.replaceChildren(alertBox('err', text)); focus?.focus(); };
  async function created(acc, autoStart, verb) {
    upsertAccount(acc);
    if (autoStart) markStarted(acc.id);
    toast(`Аккаунт добавлен: ${acc.label}${autoStart ? ` — ${verb}` : ''}`, 'ok');
    dlg.close('done');
  }

  /* ----- tab 1: login + password ----- */
  function passwordTab() {
    const login = textInput({ placeholder: 'email или логин TikTok', autocomplete: 'off', required: true });
    const password = passwordField({ autocomplete: 'new-password', placeholder: 'Пароль от TikTok' });
    const meta = metaFields({ label: true, notes: true });
    const auto = checkField({ label: 'Сразу войти', checked: true, hint: 'Если TikTok попросит код, он придёт на почту — мы покажем окно для ввода.' });
    const errors = h('div');
    const form = h('form', { id: 'add-password', class: 'stack', novalidate: true, onsubmit: (e) => {
      e.preventDefault();
      const loginValue = login.value.trim();
      const m = meta.read();
      if (!loginValue) return invalid(errors, 'Укажите логин или email', login);
      if (!password.input.value) return invalid(errors, 'Укажите пароль', password.input);
      if (proxyProblem(m.proxy)) return invalid(errors, proxyProblem(m.proxy), meta.proxy);
      return run('password', errors, async () => {
        const acc = await api.post('/api/accounts', { method: 'password', login: loginValue, password: password.input.value, ...m, autoStart: auto.input.checked });
        await created(acc, auto.input.checked, 'вход запущен');
      });
    } }, h('p', { class: 'hint' }, 'Коды подтверждения из почты вы вводите сами — после входа появится окно для кода.'),
    h('div', { class: 'grid2' }, field('Логин / email', login), field('Пароль', password.el, { forId: password.input.id })),
    ...meta.nodes, auto.el, errors);
    forms.password = { form, focus: login };
    return form;
  }

  /* ----- tab 2: session cookies ----- */
  function sessionTab() {
    const session = textArea({ rows: 8, class: 'textarea mono', placeholder: 'Вставьте cookies: JSON, cookies.txt или строку Cookie…' });
    const login = textInput({ placeholder: 'Необязательно' });
    const meta = metaFields({ label: true });
    const auto = checkField({ label: 'Сразу проверить сессию', checked: true });
    const errors = h('div');
    const form = h('form', { id: 'add-session', class: 'stack', novalidate: true, onsubmit: (e) => {
      e.preventDefault();
      const m = meta.read();
      if (!session.value.trim()) return invalid(errors, 'Вставьте cookies аккаунта', session);
      if (proxyProblem(m.proxy)) return invalid(errors, proxyProblem(m.proxy), meta.proxy);
      return run('session', errors, async () => {
        const acc = await api.post('/api/accounts', { method: 'session', session: session.value.trim(), ...compact({ login: login.value.trim() }), ...m, autoStart: auto.input.checked });
        await created(acc, auto.input.checked, 'проверяем сессию');
      });
    } },
    field('Cookies сессии', session, { hint: 'Формат определяется автоматически.' }),
    h('details', { class: 'formats' }, h('summary', null, 'Поддерживаемые форматы'), codeList([
      ['JSON-массив из расширений EditThisCookie, Cookie-Editor, Cookie-Quick-Manager'],
      ['Playwright storageState: ', h('code', null, '{"cookies":[…],"origins":[…]}')],
      ['Объект ', h('code', null, '{"cookies":[…]}')],
      ['Netscape ', h('code', null, 'cookies.txt')],
      ['Заголовок ', h('code', null, 'Cookie: name=value; name2=value2')],
      ['Cookies без домена привязываются к ', h('code', null, '.tiktok.com')]
    ])),
    h('div', { class: 'grid2' }, field('Логин (необязательно)', login)),
    ...meta.nodes, auto.el, errors);
    forms.session = { form, focus: session };
    return form;
  }

  /* ----- tab 3: bulk import ----- */
  function importTab() {
    const text = textArea({ rows: 9, class: 'textarea mono', placeholder: 'login:password\nlogin2;password2\nlogin3|password3|socks5://u:p@1.2.3.4:1080|nutra,vip|Aurora Media' });
    const counter = h('p', { class: 'import-count', 'aria-live': 'polite' });
    const meta = metaFields();
    const auto = checkField({ label: 'Сразу войти во все добавленные', checked: false, hint: 'Для большой партии лучше сначала импортировать, а входить потом пачками.' });
    const result = h('div');
    const errors = h('div');
    const count = () => {
      let rows = 0, comments = 0;
      for (const raw of text.value.split(/\r?\n/)) { const line = raw.trim(); if (!line) continue; if (line.startsWith('#')) comments += 1; else rows += 1; }
      counter.textContent = rows ? `К импорту: ${rows} ${plural(rows, 'строка', 'строки', 'строк')}${comments ? ` · комментариев: ${comments}` : ''}` : 'Вставьте по одному аккаунту на строку';
      counter.classList.toggle('on', rows > 0);
      return rows;
    };
    text.addEventListener('input', count);
    const form = h('form', { id: 'add-import', class: 'stack', novalidate: true, onsubmit: (e) => {
      e.preventDefault();
      const m = meta.read();
      if (!count()) return invalid(errors, 'Добавьте хотя бы одну строку', text);
      if (proxyProblem(m.proxy)) return invalid(errors, proxyProblem(m.proxy), meta.proxy);
      return run('import', errors, async () => {
        result.replaceChildren();
        const res = await api.post('/api/accounts/import', { text: text.value, ...m, autoStart: auto.input.checked });
        if (res.created) loadAccounts().catch(() => {});
        const { created: ok = 0, skipped = 0, errors: bad = [] } = res;
        if (!bad.length && ok) { toast(`Импортировано: ${ok} ${plural(ok, 'аккаунт', 'аккаунта', 'аккаунтов')}${skipped ? `, пропущено ${skipped}` : ''}`, 'ok'); dlg.close('done'); return; }
        result.replaceChildren(h('div', { class: 'import-result' },
          h('div', { class: 'row wrap' }, h('span', { class: 'pill ok' }, `Добавлено: ${ok}`), h('span', { class: 'pill' }, `Пропущено (уже есть): ${skipped}`), h('span', { class: `pill ${bad.length ? 'err' : ''}` }, `Ошибок: ${bad.length}`)),
          bad.length ? h('ul', { class: 'import-errors' }, bad.map((x) => h('li', null, h('b', null, `Строка ${x.line}: `), x.error))) : null));
      });
    } },
    field('Аккаунты, по одному на строку', text), counter,
    h('details', { class: 'formats' }, h('summary', null, 'Форматы строк'), codeList([
      [h('code', null, 'login:password')], [h('code', null, 'login;password')],
      [h('code', null, 'login|password|proxy|tag1,tag2|client'), ' — proxy, теги и клиент необязательны'],
      ['Поля можно разделять табуляцией (вставка из Excel)'], ['Строка, начинающаяся с ', h('code', null, '#'), ', — комментарий']
    ])),
    h('p', { class: 'label' }, 'Значения по умолчанию для всех строк'),
    ...meta.nodes, auto.el, result, errors);
    count();
    forms.import = { form, focus: text };
    return form;
  }

  const t = tabs([
    { id: 'password', label: 'Логин и пароль', icon: 'key', render: passwordTab },
    { id: 'session', label: 'Сессия (cookies)', icon: 'cookie', render: sessionTab },
    { id: 'import', label: 'Массовый импорт', icon: 'list', render: importTab }
  ], { active: tab, label: 'Способ добавления', onChange: (id) => { submit.setAttribute('form', `add-${id}`); paintSubmit(labels[id]); queueMicrotask(() => forms[id]?.focus?.focus()); } });

  const dlg = openModal({
    title: 'Добавить аккаунт', subtitle: 'Логин TikTok Ads для работы в панели', size: 'lg', backdropClose: false, body: t.el, initialFocus: () => forms[t.active]?.focus,
    footer: [h('button', { class: 'btn', type: 'button', onclick: () => dlg.close('cancel') }, 'Отмена'), submit]
  });
  return dlg;
}
