// «Настройки»: profile & password, auto-sync, users (owner), system status.
import { h, fill, toast } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { api } from '../lib/api.js';
import { session, canEdit, isOwner, system, loadSystem, on } from '../lib/store.js';
import { alertBox, loadingBlock, errorState, reportError } from '../lib/ui.js';
import { field, textInput, passwordField, switchField } from '../lib/forms.js';
import { pill, spinner, ROLE_LABEL } from '../lib/status.js';
import { num, relTime, uptime, fmtDateTime } from '../lib/format.js';
import { mountUsers } from './settings-users.js';

const section = (glyph, title, hint, ...content) => h('section', { class: 'card settings-card' },
  h('div', { class: 'card-head' }, h('div', null, h('h2', { class: 'card-title' }, icon(glyph, 16), title), hint ? h('p', { class: 'muted small' }, hint) : null)), h('div', { class: 'settings-body' }, ...content));

function profileSection() {
  const user = session.user;
  const current = passwordField({ autocomplete: 'current-password', placeholder: 'Текущий пароль' });
  const next = passwordField({ autocomplete: 'new-password', placeholder: 'Не короче 10 символов' });
  const repeat = passwordField({ autocomplete: 'new-password', placeholder: 'Повторите новый пароль' });
  const msg = h('div');
  const btn = h('button', { class: 'btn primary', type: 'submit' }, icon('lock', 15), 'Сменить пароль');
  const form = h('form', { class: 'stack', novalidate: true, onsubmit: async (e) => {
    e.preventDefault();
    const problem = !current.input.value ? 'Введите текущий пароль' : next.input.value.length < 10 ? 'Новый пароль должен быть не короче 10 символов'
      : next.input.value !== repeat.input.value ? 'Пароли не совпадают' : next.input.value === current.input.value ? 'Новый пароль должен отличаться от текущего' : '';
    if (problem) { fill(msg, alertBox('err', problem)); return; }
    btn.disabled = true; btn.replaceChildren(spinner(), 'Сохраняем…'); fill(msg);
    try {
      await api.post('/api/auth/change-password', { currentPassword: current.input.value, newPassword: next.input.value });
      for (const p of [current, next, repeat]) p.input.value = '';
      fill(msg, alertBox('ok', 'Пароль изменён.'));
      toast('Пароль изменён', 'ok');
    } catch (error) { if (!error.silent) fill(msg, alertBox('err', error.message)); }
    btn.disabled = false; btn.replaceChildren(icon('lock', 15), 'Сменить пароль');
  } }, field('Текущий пароль', current.el, { forId: current.input.id }), h('div', { class: 'grid2' }, field('Новый пароль', next.el, { forId: next.input.id }), field('Повторите', repeat.el, { forId: repeat.input.id })), msg, h('div', { class: 'row' }, btn));
  return section('user', 'Профиль', 'Ваша учётная запись и пароль для входа.',
    h('div', { class: 'profile-line' }, h('span', { class: 'avatar big', 'aria-hidden': 'true' }, (user.login || '?').slice(0, 1)), h('div', null, h('b', null, user.login), h('div', { class: 'muted small' }, `${ROLE_LABEL[user.role] ?? user.role} · последний вход ${fmtDateTime(user.lastLoginAt)}`))),
    form);
}

function autoSyncSection() {
  const edit = canEdit();
  const body = h('div', { class: 'stack' }, loadingBlock());
  const card = section('refresh', 'Автосинхронизация', 'Как часто обновлять кабинеты и проверять сессии активных логинов.', body);
  (async () => {
    let settings;
    try { settings = await api.get('/api/settings'); } catch (error) { fill(body, errorState(error.message)); return; }
    const sw = switchField({ label: 'Автосинхронизация включена', hint: 'Отключённые аккаунты всегда пропускаются.', checked: settings.autoSyncEnabled, disabled: !edit });
    const interval = textInput({ type: 'number', min: 15, max: 1440, step: 1, value: String(settings.syncIntervalMin), disabled: !edit, inputmode: 'numeric', class: 'input narrow' });
    const msg = h('div');
    const save = h('button', { class: 'btn primary', type: 'submit', disabled: !edit }, icon('check', 15), 'Сохранить');
    const form = h('form', { class: 'stack', novalidate: true, onsubmit: async (e) => {
      e.preventDefault();
      const minutes = Number(interval.value);
      if (!Number.isInteger(minutes) || minutes < 15 || minutes > 1440) { fill(msg, alertBox('err', 'Интервал — целое число от 15 до 1440 минут')); interval.focus(); return; }
      save.disabled = true; fill(msg);
      try {
        const next = await api.put('/api/settings', { autoSyncEnabled: sw.input.checked, syncIntervalMin: minutes });
        interval.value = String(next.syncIntervalMin);
        sw.input.checked = next.autoSyncEnabled;
        toast('Настройки сохранены', 'ok');
        loadSystem();
      } catch (error) { if (!error.silent) fill(msg, alertBox('err', error.message)); }
      save.disabled = !edit;
    } }, sw.el, field('Интервал, минут', interval, { hint: 'От 15 минут до суток (1440).' }), msg, edit ? h('div', { class: 'row' }, save) : alertBox('info', 'Менять настройки может администратор или владелец.'));
    fill(body, form);
  })();
  return card;
}

function systemSection() {
  const body = h('div', null, loadingBlock());
  const refresh = h('button', { class: 'btn sm', type: 'button', onclick: async () => { refresh.disabled = true; await loadSystem(); refresh.disabled = false; } }, icon('refresh', 14), 'Обновить');
  const card = section('server', 'Система', 'Состояние сервера, браузера и планировщика.', body);
  card.querySelector('.card-head').append(refresh);
  const row = (k, v) => [h('dt', null, k), h('dd', null, v)];
  const draw = (s) => {
    if (!s) return;
    const b = s.browser ?? {}, i = b.interactive ?? {}, bg = b.background ?? {}, sc = s.scheduler ?? {}, c = s.counts ?? {};
    fill(body, h('div', { class: 'sys-grid' },
      h('dl', { class: 'kv-list' }, ...row('Версия', s.version), ...row('Аптайм', uptime(s.uptimeSec)), ...row('Node.js', s.node), ...row('Источник TikTok', h('span', { class: 'mono' }, s.tiktokOrigin))),
      h('dl', { class: 'kv-list' },
        ...row('Браузер', b.ready ? pill('Готов', 'ok', { glyph: 'check' }) : pill('Недоступен', 'err', { glyph: 'x' })), ...row('Режим', b.headless ? 'без окна (headless)' : 'с окном'),
        ...row('Интерактивные сессии', `${num(i.active)} из ${num(i.max)}`), ...row('Фоновые сессии', `${num(bg.active)} из ${num(bg.max)}, в очереди ${num(bg.queued)}`)),
      h('dl', { class: 'kv-list' },
        ...row('Планировщик', sc.enabled ? pill('Включён', 'ok', { glyph: 'check' }) : pill('Выключен', 'muted', { glyph: 'pause' })), ...row('Интервал', sc.enabled ? `каждые ${num(sc.intervalMin)} мин` : '—'),
        ...row('Последний запуск', sc.lastRunAt ? relTime(sc.lastRunAt) : '—'), ...row('Следующий', sc.enabled && sc.nextRunAt ? relTime(sc.nextRunAt) : '—'), ...row('Сейчас', sc.running ? 'идёт синхронизация' : 'простаивает')),
      h('dl', { class: 'kv-list' }, ...row('Аккаунтов', num(c.accounts)), ...row('Рекламных кабинетов', num(c.adAccounts)), ...row('Кампаний', num(c.campaigns)))));
  };
  draw(system.data);
  loadSystem().then(() => { if (!system.data) fill(body, errorState('Не удалось получить состояние системы', () => { fill(body, loadingBlock()); loadSystem(); })); });
  return { card, draw };
}

export function mount(root) {
  const sys = systemSection();
  const cards = [h('div', { class: 'settings-col' }, profileSection(), autoSyncSection()), h('div', { class: 'settings-col' }, sys.card)];
  const page = h('div', { class: 'page-pad' }, h('div', { class: 'settings-grid' }, ...cards));
  let usersUnmount = null;
  if (isOwner()) {
    const users = h('div');
    page.append(users);
    usersUnmount = mountUsers(users, { section });
  }
  root.append(page);
  const off = on('system', sys.draw);
  return () => { off(); usersUnmount?.(); };
}
