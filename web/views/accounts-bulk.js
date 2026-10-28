// Bulk action bar for selected logins + result summary.
import { h, toast } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { accounts } from '../lib/store.js';
import { confirmDialog, promptDialog, openModal, reportError } from '../lib/ui.js';
import { bulkAction, countLabel } from './account-actions.js';

const PROXY_RE = /^(https?|socks[45]h?):\/\/\S+$/i;

function showFailures(title, total, res) {
  const rows = res.failed.map((f) => h('tr', null, h('td', null, accounts.byId.get(f.id)?.label ?? `№${f.id}`), h('td', { class: 'err-text' }, f.error)));
  const dlg = openModal({
    title, size: 'md', subtitle: `Выполнено: ${res.ok.length} из ${total} · с ошибкой: ${res.failed.length}`,
    body: h('div', { class: 'table-box' }, h('table', { class: 'dtable plain' }, h('thead', null, h('tr', null, h('th', null, 'Аккаунт'), h('th', null, 'Ошибка'))), h('tbody', null, rows))),
    footer: [h('button', { class: 'btn primary', type: 'button', onclick: () => dlg.close('ok') }, 'Понятно')]
  });
}

export function createBulkBar({ selection, clear }) {
  const el = h('div', { class: 'bulk-bar', role: 'toolbar', 'aria-label': 'Действия с выбранными аккаунтами', hidden: true });
  const counter = h('span', { class: 'bulk-count' });
  let busy = false;
  const buttons = [];

  async function run(title, action, value, { after } = {}) {
    const ids = [...selection];
    if (!ids.length || busy) return;
    busy = true; paint();
    try {
      const res = await bulkAction(ids, action, value);
      after?.(res);
      if (res.failed.length) { toast(`${title}: с ошибкой ${res.failed.length} из ${ids.length}`, 'warn'); showFailures(title, ids.length, res); }
      else toast(`${title}: выполнено для ${countLabel(res.ok.length)}`, 'ok');
    } catch (error) { reportError(error); } finally { busy = false; paint(); }
  }

  const need = () => selection.size;
  const btn = (label, glyph, onClick, cls = '') => {
    const b = h('button', { class: `btn sm ${cls}`, type: 'button', onclick: onClick }, icon(glyph, 14), label);
    buttons.push(b);
    return b;
  };
  el.append(counter,
    btn('Войти', 'log-in', async () => {
      if (need() > 5 && !(await confirmDialog({ title: 'Запустить вход?', text: `Вход будет запущен для ${countLabel(need())}. Браузеры стартуют пачками, коды из почты придётся вводить по очереди.`, confirmLabel: 'Запустить' }))) return;
      run('Вход', 'login');
    }),
    btn('Проверить', 'shield', () => run('Проверка сессий', 'check')),
    btn('Синхронизировать', 'refresh', () => run('Синхронизация', 'sync')),
    h('span', { class: 'bulk-sep' }),
    btn('Тег', 'tag', async () => {
      const value = await promptDialog({ title: 'Добавить тег', label: 'Тег', suggestions: accounts.tags, placeholder: 'например, nutra', hint: `Тег будет добавлен: ${countLabel(need())}.`, confirmLabel: 'Добавить' });
      if (value) run('Добавление тега', 'tag', value);
    }),
    btn('Клиент', 'user', async () => {
      const value = await promptDialog({ title: 'Назначить клиента', label: 'Клиент', suggestions: accounts.clients, allowEmpty: true, hint: 'Оставьте пустым, чтобы убрать клиента.', confirmLabel: 'Применить' });
      if (value !== null) run('Назначение клиента', 'set_client', value);
    }),
    btn('Прокси', 'globe', async () => {
      const value = await promptDialog({ title: 'Назначить прокси', label: 'Прокси', placeholder: 'http://user:pass@host:port', allowEmpty: true, hint: 'Один прокси для всех выбранных. Пусто — убрать прокси.', confirmLabel: 'Применить', validate: (v) => (v && !PROXY_RE.test(v) ? 'Формат: http://user:pass@host:port или socks5://…' : '') });
      if (value !== null) run('Назначение прокси', 'set_proxy', value);
    }),
    h('span', { class: 'bulk-sep' }),
    btn('Отключить', 'pause', () => run('Отключение', 'disable')),
    btn('Включить', 'play', () => run('Включение', 'enable')),
    btn('Удалить', 'trash', async () => {
      const ok = await confirmDialog({ title: 'Удалить выбранные аккаунты?', danger: true, confirmLabel: 'Удалить', text: `Будет удалено: ${countLabel(need())}, вместе с их кабинетами и журналом. Действие нельзя отменить.` });
      if (ok) run('Удаление', 'delete', undefined, { after: (res) => { for (const id of res.ok) selection.delete(id); } });
    }, 'danger-soft'),
    h('button', { class: 'icon-btn sm', type: 'button', title: 'Снять выделение', 'aria-label': 'Снять выделение', onclick: clear }, icon('x', 16)));

  function paint() {
    counter.textContent = `Выбрано: ${selection.size}`;
    for (const b of buttons) b.disabled = busy;
    el.classList.toggle('busy', busy);
  }
  return {
    el,
    update() { el.hidden = selection.size === 0; paint(); }
  };
}
