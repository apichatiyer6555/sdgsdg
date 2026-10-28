// Full-screen auth views: login form and the forced «change your password» step.
import { h, $, fill } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { api } from '../lib/api.js';
import { field, textInput, passwordField } from '../lib/forms.js';
import { alertBox } from '../lib/ui.js';
import { spinner } from '../lib/status.js';

const FEATURES = [
  ['users', 'Сотни логинов в одном месте', 'Вход по паролю или по cookies-сессии, прокси и клиенты у каждого аккаунта.'],
  ['chart', 'Статусы и расход по кабинетам', 'Доставка, причины проблем и расход за 7 дней без захода в каждый кабинет.'],
  ['monitor', 'Удалённый браузер', 'Капча и ручные шаги решаются прямо из панели.']
];

function authScreen(card) {
  fill($('#app'), h('main', { class: 'auth' },
    h('section', { class: 'auth-hero' },
      h('div', { class: 'auth-brand' }, h('img', { src: '/assets/logo.svg', alt: '', width: 52, height: 52 }),
        h('div', null, h('h1', null, 'Zaliv'), h('p', null, 'TikTok Ads Hub'))),
      h('p', { class: 'auth-tagline' }, 'Один пульт для всех TikTok Ads аккаунтов агентства.'),
      h('ul', { class: 'auth-features' }, FEATURES.map(([glyph, title, text]) =>
        h('li', null, h('span', { class: 'auth-ico' }, icon(glyph, 18)), h('div', null, h('b', null, title), h('span', null, text)))))),
    card));
}

function submitButton(label) {
  const btn = h('button', { class: 'btn primary block', type: 'submit' }, label);
  const busy = (on) => { btn.disabled = on; btn.replaceChildren(...(on ? [spinner(), 'Подождите…'] : [label])); };
  return { btn, busy };
}

export function showLogin({ notice = '', onSuccess }) {
  const login = textInput({ name: 'login', autocomplete: 'username', placeholder: 'Ваш логин', required: true, autocapitalize: 'off' });
  const password = passwordField({ name: 'password', autocomplete: 'current-password', placeholder: 'Пароль' });
  const errorSlot = h('div', null, notice ? alertBox('info', notice) : null);
  const { btn, busy } = submitButton('Войти');
  const form = h('form', { class: 'auth-card', novalidate: true, onsubmit: async (e) => {
    e.preventDefault();
    const loginValue = login.value.trim();
    if (!loginValue || !password.input.value) {
      fill(errorSlot, alertBox('err', 'Введите логин и пароль'));
      (loginValue ? password.input : login).focus();
      return;
    }
    busy(true);
    fill(errorSlot);
    try {
      const res = await api.post('/api/auth/login', { login: loginValue, password: password.input.value }, { auth: false });
      onSuccess(res);
    } catch (error) {
      fill(errorSlot, alertBox('err', error.message));
      password.input.select();
      busy(false);
    }
  } },
  h('div', { class: 'auth-card-head' }, h('h2', null, 'Вход в панель'), h('p', null, 'Введите данные, которые выдал владелец.')),
  errorSlot,
  field('Логин', login), field('Пароль', password.el, { forId: password.input.id }),
  btn);
  authScreen(form);
  login.focus();
}

export function showForcedChange({ user, onDone, onLogout }) {
  const current = passwordField({ autocomplete: 'current-password', placeholder: 'Текущий пароль' });
  const next = passwordField({ autocomplete: 'new-password', placeholder: 'Не короче 10 символов' });
  const repeat = passwordField({ autocomplete: 'new-password', placeholder: 'Повторите новый пароль' });
  const errorSlot = h('div');
  const { btn, busy } = submitButton('Сохранить и продолжить');
  const form = h('form', { class: 'auth-card', novalidate: true, onsubmit: async (e) => {
    e.preventDefault();
    const problem = !current.input.value ? 'Введите текущий пароль'
      : next.input.value.length < 10 ? 'Новый пароль должен быть не короче 10 символов'
        : next.input.value !== repeat.input.value ? 'Пароли не совпадают'
          : next.input.value === current.input.value ? 'Новый пароль должен отличаться от текущего' : '';
    if (problem) { fill(errorSlot, alertBox('err', problem)); return; }
    busy(true);
    fill(errorSlot);
    try {
      await api.post('/api/auth/change-password', { currentPassword: current.input.value, newPassword: next.input.value });
      await onDone();
    } catch (error) {
      if (!error.silent) fill(errorSlot, alertBox('err', error.message));
      busy(false);
    }
  } },
  h('div', { class: 'auth-card-head' }, h('h2', null, 'Смените пароль'),
    h('p', null, `${user?.login ? `${user.login}, для` : 'Для'} безопасности замените временный пароль на свой. Минимум 10 символов.`)),
  errorSlot,
  field('Текущий пароль', current.el, { forId: current.input.id }),
  field('Новый пароль', next.el, { forId: next.input.id }),
  field('Повторите новый пароль', repeat.el, { forId: repeat.input.id }),
  btn,
  h('button', { class: 'linklike center-link', type: 'button', onclick: onLogout }, 'Выйти'));
  authScreen(form);
  current.input.focus();
}
