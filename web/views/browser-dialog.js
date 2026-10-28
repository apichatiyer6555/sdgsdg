// Remote browser: live screenshot, click / type / scroll / navigate, open & close the assist browser.
import { h, toast } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { api } from '../lib/api.js';
import { accounts, on, canEdit } from '../lib/store.js';
import { openModal, alertBox, reportError } from '../lib/ui.js';
import { textInput, checkField } from '../lib/forms.js';
import { screenLoop } from '../lib/screen-loop.js';
import { accountStatusChip, pill } from '../lib/status.js';
import { cancelAccount } from './account-actions.js';

const KEYS = { Enter: 'Enter', Backspace: 'Backspace', Delete: 'Delete', ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown' };
const open = new Map();

export function tiktokUrl(text) {
  const raw = text.trim();
  if (!raw) return { error: 'Введите адрес' };
  let url;
  try { url = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`); } catch { return { error: 'Некорректный адрес' }; }
  const host = url.hostname.toLowerCase();
  if (!/^https?:$/.test(url.protocol) || !(host === 'tiktok.com' || host.endsWith('.tiktok.com'))) return { error: 'Разрешены только адреса *.tiktok.com' };
  return { url: url.toString() };
}

export function openBrowserDialog(account) {
  const id = account.id;
  if (open.get(id)?.open) return open.get(id);
  const live = () => accounts.byId.get(id) ?? account;
  let info = null, stopped = false, hasFrame = false, infoTimer = 0;

  /* ----- viewport ----- */
  const img = h('img', { class: 'rb-img', alt: 'Экран удалённого браузера', draggable: 'false', tabindex: '0' });
  const overlay = h('div', { class: 'rb-overlay' });
  const stage = h('div', { class: 'rb-stage' }, img, overlay);
  const urlLine = h('div', { class: 'rb-url mono ellipsis' });
  const titleLine = h('div', { class: 'rb-title ellipsis' });
  const stateSlot = h('span');
  const note = h('div', { class: 'rb-note', 'aria-live': 'polite' });
  const setNote = (text, kind = 'warn') => { note.replaceChildren(text ? alertBox(kind, text) : ''); };

  const dims = () => ({ w: info?.width || img.naturalWidth || 1280, h: info?.height || img.naturalHeight || 800 });
  const map = (e) => {
    const r = img.getBoundingClientRect(), d = dims();
    return { x: Math.round(Math.min(Math.max((e.clientX - r.left) / r.width, 0), 1) * d.w), y: Math.round(Math.min(Math.max((e.clientY - r.top) / r.height, 0), 1) * d.h) };
  };

  /* ----- input: strictly sequential requests ----- */
  let chain = Promise.resolve();
  const send = (payload) => {
    chain = chain.then(() => api.post(`/api/accounts/${id}/browser/input`, payload)).then(() => setNote(''))
      .catch((error) => { if (!error.silent) { setNote(error.status === 404 ? 'Браузер не запущен: действие не выполнено.' : error.message, 'err'); if (error.status === 404) refreshInfo(); } });
    loop.poke();
    return chain;
  };
  let typed = '', typedTimer = 0, wheelDy = 0, wheelTimer = 0, wheelAt = { x: 0, y: 0 };
  const flushTyped = () => { clearTimeout(typedTimer); if (typed) { const text = typed; typed = ''; send({ type: 'type', text }); } };

  img.addEventListener('click', (e) => {
    img.focus({ preventScroll: true });
    if (!info?.active) return;
    const p = map(e);
    flushTyped();
    send({ type: 'click', x: p.x, y: p.y });
    const r = stage.getBoundingClientRect();
    const ping = h('span', { class: 'rb-ping', style: { left: `${e.clientX - r.left}px`, top: `${e.clientY - r.top}px` } });
    stage.append(ping);
    setTimeout(() => ping.remove(), 600);
  });
  img.addEventListener('wheel', (e) => {
    if (!info?.active) return;
    e.preventDefault();
    wheelDy += e.deltaMode === 1 ? e.deltaY * 40 : e.deltaY;
    wheelAt = map(e);
    clearTimeout(wheelTimer);
    wheelTimer = setTimeout(() => { const dy = Math.round(wheelDy); wheelDy = 0; if (dy) send({ type: 'scroll', x: wheelAt.x, y: wheelAt.y, dy }); }, 80);
  }, { passive: false });
  img.addEventListener('keydown', (e) => {
    if (!info?.active || e.key === 'Escape') return; // Esc keeps closing the dialog; Tab keeps moving focus
    if (e.ctrlKey || e.metaKey) { if (e.key.toLowerCase() === 'a') { e.preventDefault(); flushTyped(); send({ type: 'key', key: 'Control+A' }); } return; }
    if (e.key.length === 1 && !e.altKey) { e.preventDefault(); typed += e.key; clearTimeout(typedTimer); typedTimer = setTimeout(flushTyped, 120); return; }
    if (KEYS[e.key]) { e.preventDefault(); flushTyped(); send({ type: 'key', key: KEYS[e.key] }); }
  });
  stage.addEventListener('paste', (e) => { const text = e.clipboardData?.getData('text'); if (text && info?.active) { e.preventDefault(); send({ type: 'type', text }); } });

  /* ----- side panel ----- */
  const addr = textInput({ placeholder: 'https://ads.tiktok.com/…', 'aria-label': 'Адрес' });
  const addrError = h('p', { class: 'form-error', role: 'alert' });
  const addrForm = h('form', { class: 'rb-row', novalidate: true, onsubmit: (e) => {
    e.preventDefault();
    const res = tiktokUrl(addr.value);
    addrError.textContent = res.error ?? '';
    if (res.url) { send({ type: 'navigate', url: res.url }); addr.value = ''; }
  } }, addr, h('button', { class: 'btn', type: 'submit', disabled: !canEdit() }, 'Перейти'));
  const text = textInput({ placeholder: 'Текст для ввода в активное поле', 'aria-label': 'Текст', autocomplete: 'off' });
  const enter = checkField({ label: 'Нажать Enter после текста' });
  const textForm = h('form', { class: 'stack', novalidate: true, onsubmit: (e) => {
    e.preventDefault();
    if (!text.value) return;
    send({ type: 'type', text: text.value });
    if (enter.input.checked) send({ type: 'key', key: 'Enter' });
    text.value = '';
  } }, h('div', { class: 'rb-row' }, text, h('button', { class: 'btn', type: 'submit' }, 'Отправить текст')), enter.el);
  const keyBtn = (label, payload, glyph) => h('button', { class: 'btn sm', type: 'button', onclick: () => { flushTyped(); send(payload); } }, glyph ? icon(glyph, 14) : null, label);
  const keys = h('div', { class: 'row wrap' },
    keyBtn('Enter', { type: 'key', key: 'Enter' }, 'enter'), keyBtn('Tab', { type: 'key', key: 'Tab' }), keyBtn('Backspace', { type: 'key', key: 'Backspace' }), keyBtn('Esc', { type: 'key', key: 'Escape' }),
    keyBtn('Вверх', { type: 'scroll', dy: -400 }, 'arrow-up'), keyBtn('Вниз', { type: 'scroll', dy: 400 }, 'arrow-down'));
  const section = (title, ...children) => h('section', { class: 'rb-section' }, h('h3', null, title), ...children);

  const openBtn = h('button', { class: 'btn primary', type: 'button', onclick: async () => {
    openBtn.disabled = true;
    try { info = await api.post(`/api/accounts/${id}/browser/open`, {}); toast('Браузер запущен с сохранённой сессией', 'ok'); paint(); loop.poke(); } catch (error) { reportError(error); }
    openBtn.disabled = false; paint();
  } }, icon('play', 15), 'Открыть браузер с сессией');
  const closeBtn = h('button', { class: 'btn', type: 'button', onclick: async () => {
    closeBtn.disabled = true;
    try {
      await api.post(`/api/accounts/${id}/browser/close`, {});
      info = { active: false }; hasFrame = false; paint(); // stop polling screenshots right away (they would answer 404)
      toast('Браузер закрыт', 'ok');
      await refreshInfo();
    } catch (error) { reportError(error); }
    paint();
  } }, icon('stop', 15), 'Закрыть браузер');
  const cancelBtn = h('button', { class: 'btn danger', type: 'button', onclick: async () => { await cancelAccount(live()); await refreshInfo(); } }, icon('x', 15), 'Отмена входа');
  const codeBtn = h('button', { class: 'btn cta', type: 'button', onclick: async () => { const { openCodeDialog } = await import('./account-code.js'); dlg.close('code'); openCodeDialog(live()); } }, icon('mail', 15), 'Ввести код');
  const kv = h('dl', { class: 'rb-kv rb-state' });
  const controls = canEdit() ? [
    section('Адрес', addrForm, addrError), section('Текст', textForm), section('Клавиши и прокрутка', keys),
    section('Сеанс', h('div', { class: 'rb-session' }, openBtn, closeBtn, cancelBtn, codeBtn)), note
  ] : [alertBox('info', 'Режим только для чтения: управлять браузером может администратор.')];
  const side = h('aside', { class: 'rb-side' }, ...controls);

  const paint = () => {
    const acc = live(), active = !!info?.active;
    stateSlot.replaceChildren(active ? pill(info.kind === 'login' ? 'Идёт вход' : 'Ручной режим', 'ok', { glyph: 'check' }) : pill('Браузер не запущен', 'muted', { glyph: 'stop' }));
    urlLine.textContent = active ? info.url || '—' : 'Браузер не запущен';
    urlLine.classList.toggle('muted', !active);
    titleLine.textContent = active ? info.title || '' : '';
    if (info?.width && info?.height) stage.style.aspectRatio = `${info.width} / ${info.height}`;
    overlay.hidden = active && hasFrame;
    if (!overlay.hidden) {
      overlay.replaceChildren(h('div', { class: 'ico-big' }, icon('monitor', 26)),
        h('b', null, active ? 'Загружаем картинку…' : 'Браузер не запущен'),
        h('span', null, active ? 'Ждём первый кадр от сервера.' : acc.hasSession ? 'Откройте браузер с сохранённой сессией — он нужен для капчи и ручных действий.' : 'У аккаунта нет сохранённой сессии. Запустите вход — браузер откроется сам.'));
    }
    img.classList.toggle('dim', !active);
    openBtn.disabled = active || !acc.hasSession;
    closeBtn.disabled = !active;
    cancelBtn.disabled = acc.busy !== 'login';
    codeBtn.hidden = acc.waitingFor !== 'code';
    const rows = [['Статус аккаунта', accountStatusChip(acc)], ['Состояние', info?.state || '—'], ['Размер окна', info?.width ? `${info.width}×${info.height}` : '—'], ['Сообщение', info?.message || '—']];
    kv.replaceChildren(...rows.flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v)]));
    if (acc.waitingFor === 'manual' && active) setNote('Нужно ручное действие (капча или подтверждение): выполните его прямо в окне.', 'warn');
  };

  async function refreshInfo() {
    try { info = await api.get(`/api/accounts/${id}/browser`); } catch (error) { if (error.status === 404) info = { active: false }; else if (!error.silent) setNote(error.message, 'err'); }
    if (!info?.active) hasFrame = false;
    if (!stopped) paint();
  }
  const pollInfo = async () => {
    if (stopped) return;
    if (!document.hidden) await refreshInfo();
    infoTimer = setTimeout(pollInfo, 2000);
  };

  const dlg = openModal({
    title: 'Удалённый браузер', subtitle: `${account.label} · ${account.login}`, size: 'xl', initialFocus: () => img,
    headExtra: h('div', { class: 'rb-head' }, stateSlot),
    body: h('div', { class: 'rb-layout' },
      h('div', { class: 'rb-view' }, h('div', { class: 'rb-bar' }, h('div', { class: 'rb-bar-text' }, urlLine, titleLine)), stage,
        h('p', { class: 'hint' }, 'Клик по картинке — клик в браузере. Когда картинка в фокусе, клавиши и вставка уходят в браузер. Esc закрывает окно.'),
        section('Состояние', kv)),
      side),
    onClose: () => { stopped = true; clearTimeout(infoTimer); clearTimeout(typedTimer); clearTimeout(wheelTimer); loop.stop(); off(); open.delete(id); }
  });
  open.set(id, dlg);
  const loop = screenLoop({
    accountId: id, img, interval: 700, enabled: () => !!info?.active,
    onFrame: () => { if (!hasFrame) { hasFrame = true; paint(); } },
    onMissing: () => { if (hasFrame) { hasFrame = false; paint(); } },
    onError: (error) => { if (!error.silent) setNote(error.message, 'err'); }
  });
  const off = on('accounts', () => { if (!accounts.byId.has(id)) { dlg.close('gone'); return; } paint(); });
  paint();
  pollInfo();
  return dlg;
}
