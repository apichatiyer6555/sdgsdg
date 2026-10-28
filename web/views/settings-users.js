// Users management (owner only): list, add, change role, reset password, disable, delete.
import { h, fill, toast } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { api } from '../lib/api.js';
import { session } from '../lib/store.js';
import { openModal, openMenu, confirmDialog, promptDialog, alertBox, errorState, loadingBlock, reportError } from '../lib/ui.js';
import { field, textInput, passwordField, selectEl } from '../lib/forms.js';
import { pill, spinner, ROLE_LABEL } from '../lib/status.js';
import { relTime, fmtDateTime } from '../lib/format.js';

const ROLES = Object.entries(ROLE_LABEL).map(([value, label]) => ({ value, label }));

function addUserDialog(onDone) {
  const login = textInput({ placeholder: 'Логин нового пользователя', autocomplete: 'off' });
  const password = passwordField({ autocomplete: 'new-password', placeholder: 'Временный пароль, не короче 10 символов' });
  const role = selectEl({ options: ROLES, value: 'admin', label: 'Роль' });
  const errors = h('div');
  const submit = h('button', { class: 'btn primary', type: 'submit', form: 'add-user-form' }, icon('user-plus', 15), 'Создать');
  const form = h('form', { id: 'add-user-form', class: 'stack', novalidate: true, onsubmit: async (e) => {
    e.preventDefault();
    const l = login.value.trim();
    const problem = l.length < 3 ? 'Логин — не короче 3 символов' : password.input.value.length < 10 ? 'Пароль — не короче 10 символов' : '';
    if (problem) { fill(errors, alertBox('err', problem)); return; }
    submit.disabled = true; submit.replaceChildren(spinner(), 'Создаём…'); fill(errors);
    try {
      const user = await api.post('/api/users', { login: l, password: password.input.value, role: role.value });
      toast(`Пользователь создан: ${user.login}. При первом входе он сменит пароль.`, 'ok');
      dlg.close('done');
      onDone();
    } catch (error) { if (!error.silent) fill(errors, alertBox('err', error.message)); submit.disabled = false; submit.replaceChildren(icon('user-plus', 15), 'Создать'); }
  } }, field('Логин', login), field('Пароль', password.el, { forId: password.input.id }),
  field('Роль', role, { hint: 'Владелец — всё, включая пользователей и экспорт cookies. Администратор — работа с аккаунтами. Наблюдатель — только просмотр.' }), errors);
  const dlg = openModal({ title: 'Новый пользователь', size: 'sm', body: form, initialFocus: login, footer: [h('button', { class: 'btn', type: 'button', onclick: () => dlg.close('cancel') }, 'Отмена'), submit] });
}

export function mountUsers(root, { section }) {
  let alive = true;
  const body = h('div', null, loadingBlock());
  const addBtn = h('button', { class: 'btn primary sm', type: 'button', onclick: () => addUserDialog(load) }, icon('user-plus', 14), 'Добавить пользователя');
  const card = section('users', 'Пользователи', 'Кто и с какими правами работает в панели. Доступно только владельцу.', body);
  card.querySelector('.card-head').append(addBtn);
  root.append(card);

  async function patch(user, change, okText) {
    try { await api.patch(`/api/users/${user.id}`, change); toast(okText, 'ok'); await load(); } catch (error) { reportError(error); await load(); }
  }

  function menu(user, btn) {
    const self = user.id === session.user.id;
    openMenu(btn, [
      { label: 'Сбросить пароль…', icon: 'key', onClick: async () => {
        const value = await promptDialog({ title: `Новый пароль: ${user.login}`, label: 'Временный пароль', hint: 'Не короче 10 символов. При следующем входе пользователь сменит его.', confirmLabel: 'Сбросить', validate: (v) => (v.length < 10 ? 'Не короче 10 символов' : '') });
        if (value) patch(user, { password: value }, 'Пароль сброшен');
      } },
      { label: user.disabled ? 'Включить' : 'Отключить', icon: user.disabled ? 'play' : 'pause', disabled: self, title: self ? 'Нельзя отключить самого себя' : undefined, onClick: () => patch(user, { disabled: !user.disabled }, user.disabled ? 'Пользователь включён' : 'Пользователь отключён') },
      { divider: true },
      { label: 'Удалить…', icon: 'trash', danger: true, disabled: self, title: self ? 'Нельзя удалить самого себя' : undefined, onClick: async () => {
        if (!(await confirmDialog({ title: 'Удалить пользователя?', danger: true, confirmLabel: 'Удалить', text: [h('b', null, user.login), ' потеряет доступ к панели. Действие нельзя отменить.'] }))) return;
        try { await api.del(`/api/users/${user.id}`); toast('Пользователь удалён', 'ok'); load(); } catch (error) { reportError(error); }
      } }
    ]);
  }

  async function load() {
    try {
      const { items } = await api.get('/api/users');
      if (!alive) return;
      fill(body, h('div', { class: 'table-box' }, h('table', { class: 'dtable plain users-table' },
        h('thead', null, h('tr', null, ['Логин', 'Роль', 'Статус', 'Последний вход', 'Создан', ''].map((t) => h('th', { scope: 'col' }, t)))),
        h('tbody', null, items.map((u) => {
          const self = u.id === session.user.id;
          const roleSel = selectEl({ options: ROLES, value: u.role, label: `Роль: ${u.login}`, className: 'sm', onChange: (v) => patch(u, { role: v }, 'Роль изменена') });
          roleSel.disabled = self;
          if (self) roleSel.title = 'Свою роль менять нельзя';
          const menuBtn = h('button', { class: 'icon-btn sm', type: 'button', title: 'Действия', 'aria-label': `Действия: ${u.login}`, 'aria-haspopup': 'menu', 'aria-expanded': 'false', onclick: (e) => menu(u, e.currentTarget) }, icon('more', 16));
          return h('tr', null,
            h('td', null, h('b', null, u.login), self ? h('span', { class: 'pill sm cyan', style: { marginLeft: '8px' } }, 'это вы') : null),
            h('td', null, roleSel),
            h('td', null, u.disabled ? pill('Отключён', 'muted', { glyph: 'pause' }) : u.mustChangePassword ? pill('Ждёт смены пароля', 'warn', { glyph: 'clock' }) : pill('Активен', 'ok', { glyph: 'check' })),
            h('td', { title: fmtDateTime(u.lastLoginAt) }, u.lastLoginAt ? relTime(u.lastLoginAt) : h('span', { class: 'muted' }, 'не входил')),
            h('td', { title: fmtDateTime(u.createdAt) }, relTime(u.createdAt)),
            h('td', { class: 'num' }, menuBtn));
        })))));
    } catch (error) { if (alive) fill(body, errorState(error.message, () => { fill(body, loadingBlock()); load(); })); }
  }
  load();
  return () => { alive = false; };
}
