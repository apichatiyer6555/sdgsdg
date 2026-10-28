// «Введите код из почты» dialog and the auto-open logic for logins started from this page.
import { h, toast } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { accounts, on, started, upsertAccount } from '../lib/store.js';
import { openModal, alertBox, reportError } from '../lib/ui.js';
import { field, textInput } from '../lib/forms.js';
import { screenLoop } from '../lib/screen-loop.js';
import { spinner, ACCOUNT_STATUS } from '../lib/status.js';
import { icon } from '../lib/icons.js';
import { openBrowserDialog } from './browser-dialog.js';

const dialogs = new Map(); // accountId -> modal handle
const queue = [];          // accounts waiting for a free code dialog

export function openCodeDialog(account) {
  const known = dialogs.get(account.id);
  if (known?.open) { known.panel.querySelector('input')?.focus(); return known; }
  const id = account.id;
  const input = textInput({ class: 'input code-input', inputmode: 'text', autocomplete: 'one-time-code', placeholder: '••••••', maxlength: 12, 'aria-label': 'Код подтверждения', 'data-autofocus': '' });
  const notice = h('div');
  const error = h('p', { class: 'form-error', role: 'alert' });
  const img = h('img', { class: 'code-shot', alt: 'Живой вид браузера, в котором идёт вход' });
  const preview = h('div', { class: 'code-preview', hidden: true }, img,
    h('div', { class: 'row' }, h('span', { class: 'muted small' }, 'Так видит страницу браузер, выполняющий вход'), h('span', { class: 'spacer' }),
      h('button', { class: 'linklike', type: 'button', onclick: () => { dlg.close('browser'); openBrowserDialog(accounts.byId.get(id) ?? account); } }, 'Открыть браузер')));
  const submit = h('button', { class: 'btn primary', type: 'submit', form: `code-form-${id}` }, 'Отправить');
  let stale = false, sending = false;
  const paintSubmit = () => {
    submit.disabled = sending;
    submit.replaceChildren(...(sending ? [spinner(), 'Отправляем…'] : stale ? ['Закрыть'] : [icon('send', 15), 'Отправить']));
  };
  const form = h('form', { id: `code-form-${id}`, class: 'stack', novalidate: true, onsubmit: async (e) => {
    e.preventDefault();
    if (stale) { dlg.close('stale'); return; }
    const code = input.value.trim();
    if (code.length < 4 || code.length > 10) { error.textContent = 'Код — от 4 до 10 символов'; input.focus(); return; }
    error.textContent = '';
    sending = true; paintSubmit();
    try {
      const next = await api.post(`/api/accounts/${id}/code`, { code });
      if (next) upsertAccount(next);
      toast('Код отправлен, проверяем вход…', 'ok');
      dlg.close('done');
    } catch (err) {
      sending = false;
      if (err.code === 'not_waiting') { stale = true; error.textContent = ''; notice.replaceChildren(alertBox('warn', 'Аккаунт сейчас не ждёт код: вход уже продвинулся дальше или был остановлен.')); }
      else if (!err.silent) error.textContent = err.message;
      paintSubmit();
      if (!stale) input.focus();
    }
  } },
  h('p', { class: 'dlg-text' }, 'TikTok отправил код подтверждения на почту аккаунта ', h('b', null, account.login), '. Введите его здесь.'),
  notice,
  field('Код из письма', input, { hint: 'Можно вставить из буфера. Пробелы и дефисы уберём сами.' }),
  error);
  input.addEventListener('input', () => {
    const clean = input.value.replace(/[^A-Za-z0-9]/g, '');
    if (clean !== input.value) input.value = clean;
    error.textContent = '';
  });

  const dlg = openModal({
    title: 'Введите код подтверждения', subtitle: account.label, size: 'sm', initialFocus: input,
    body: [form, preview],
    footer: [h('button', { class: 'btn', type: 'button', onclick: () => dlg.close('cancel') }, 'Отмена'), submit],
    onClose: () => { loop.stop(); off(); dialogs.delete(id); drain(); }
  });
  paintSubmit();
  dialogs.set(id, dlg);

  const loop = screenLoop({
    accountId: id, img, interval: 1500,
    onFrame: () => { preview.hidden = false; },
    onMissing: () => { preview.hidden = true; }
  });
  const off = on('accounts', () => {
    const live = accounts.byId.get(id);
    if (!live) { dlg.close('gone'); return; }
    if (live.waitingFor !== 'code' && !stale && !sending) {
      stale = true;
      const label = ACCOUNT_STATUS[live.status]?.label ?? live.status;
      notice.replaceChildren(alertBox('info', `Код больше не нужен. Текущий статус: ${label}.`));
      paintSubmit();
    }
  });
  return dlg;
}

function drain() {
  if (dialogs.size) return;
  while (queue.length) {
    const next = accounts.byId.get(queue.shift().id);
    if (next?.waitingFor === 'code') { openCodeDialog(next); return; }
  }
}

// Opens the code dialog once for every login the operator started here (one at a time).
export function initCodeAutoOpen() {
  const opened = new Set();
  const present = (a) => {
    const active = document.activeElement;
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(active?.tagName ?? '') && !['checkbox', 'radio', 'button'].includes(active.type);
    if (typing) { toast(`${a.label}: нужен код подтверждения`, 'warn', { ms: 20000, action: { label: 'Ввести код', onClick: () => openCodeDialog(a) } }); return; }
    if (dialogs.size) { queue.push(a); return; }
    openCodeDialog(a);
  };
  const check = () => {
    for (const id of [...started]) {
      const a = accounts.byId.get(id);
      if (!a) { started.delete(id); opened.delete(id); continue; }
      if (a.waitingFor === 'code') {
        if (!opened.has(id)) { opened.add(id); present(a); }
      } else {
        opened.delete(id);
        if (!a.busy) started.delete(id);
      }
    }
  };
  const offs = [on('accounts', check), on('started', check)];
  return () => { for (const off of offs) off(); queue.length = 0; };
}
