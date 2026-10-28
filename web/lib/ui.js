// Layers (modals, drawers, menus), confirm / prompt dialogs, tabs, filter chips and shared page states.
import { h, $, cx, uid, toast } from './dom.js';
import { icon } from './icons.js';
import { spinner } from './status.js';
import { field, textInput } from './forms.js';

/* ---------- layer stack: Esc closes the top-most layer, Tab is trapped inside modals ---------- */
const layers = [];
const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]):not([type=hidden]),select:not([disabled]),textarea:not([disabled]),summary,[tabindex]:not([tabindex="-1"])';
const isVisible = (el) => !el.closest('[hidden]') && el.getClientRects().length > 0;
const focusables = (root) => [...root.querySelectorAll(FOCUSABLE)].filter(isVisible);

function syncInert() {
  const app = $('#app');
  if (app) app.inert = layers.some((l) => l.modal);
}

function onKeydown(e) {
  const top = layers.at(-1);
  if (!top) return;
  if (e.key === 'Escape') {
    if (top.dismissable) { e.preventDefault(); e.stopPropagation(); top.close('escape'); }
    return;
  }
  if (e.key !== 'Tab' || !top.modal) return;
  const items = focusables(top.panel);
  if (!items.length) { e.preventDefault(); top.panel.focus(); return; }
  const first = items[0], last = items.at(-1), active = document.activeElement;
  if (!top.panel.contains(active)) { e.preventDefault(); first.focus(); }
  else if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
}

function pushLayer(layer) {
  if (!layers.length) document.addEventListener('keydown', onKeydown, true);
  layers.push(layer);
  $('#layers').append(layer.el);
  syncInert();
}
function removeLayer(layer) {
  const index = layers.indexOf(layer);
  if (index < 0) return false;
  layers.splice(index, 1);
  layer.el.remove();
  if (!layers.length) document.removeEventListener('keydown', onKeydown, true);
  syncInert();
  return true;
}
export const hasOpenLayer = () => layers.some((l) => l.modal);
export function closeAllLayers() { for (const layer of [...layers].reverse()) layer.close('navigate'); }

function pickFocus(layer, initialFocus) {
  let target = typeof initialFocus === 'function' ? initialFocus() : initialFocus;
  if (typeof target === 'string') target = layer.panel.querySelector(target);
  target ??= layer.panel.querySelector('[data-autofocus]')
    ?? focusables(layer.panel).find((el) => /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName) && !['checkbox', 'radio'].includes(el.type))
    ?? focusables(layer.panel).find((el) => !el.classList.contains('panel-close'))
    ?? layer.panel;
  target.focus({ preventScroll: true });
}

function panelLayer(kind, opts) {
  const { title, subtitle, body, footer, headExtra, size = 'md', width, dismissable = true, backdropClose = true, onClose, initialFocus, className } = opts;
  const previous = document.activeElement;
  const titleId = uid('dlg');
  const titleEl = h('h2', { id: titleId }, title);
  const subEl = h('p', { class: 'panel-sub' }, subtitle ?? '');
  subEl.hidden = !subtitle;
  const bodyEl = h('div', { class: 'panel-body' }, body);
  const footEl = footer ? h('footer', { class: 'panel-foot' }, footer) : null;
  const closeBtn = dismissable
    ? h('button', { class: 'icon-btn panel-close', type: 'button', 'aria-label': 'Закрыть', title: 'Закрыть (Esc)', onclick: () => layer.close('button') }, icon('x', 18))
    : null;
  const panel = h('section', {
    class: cx('panel', kind, kind === 'modal' && `modal-${size}`, className), role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, tabindex: '-1',
    style: width ? { '--w': `${width}px` } : null
  }, h('header', { class: 'panel-head' }, h('div', { class: 'panel-titles' }, titleEl, subEl), headExtra, closeBtn), bodyEl, footEl);
  let downOnBackdrop = false;
  const backdrop = h('div', {
    class: 'backdrop',
    onpointerdown: (e) => { downOnBackdrop = e.target === e.currentTarget; },
    onclick: (e) => { if (downOnBackdrop && e.target === e.currentTarget && backdropClose && dismissable) layer.close('backdrop'); downOnBackdrop = false; }
  });
  const layer = {
    el: h('div', { class: `layer layer-${kind}` }, backdrop, panel), panel, modal: true, dismissable, body: bodyEl, foot: footEl,
    close(reason = 'api') {
      if (!removeLayer(layer)) return;
      try { if (previous?.isConnected) previous.focus({ preventScroll: true }); } catch { /* the opener may be gone */ }
      onClose?.(reason);
    },
    setTitle(text) { titleEl.textContent = text; },
    setSubtitle(text) { subEl.textContent = text ?? ''; subEl.hidden = !text; },
    get open() { return layers.includes(layer); }
  };
  pushLayer(layer);
  queueMicrotask(() => { if (layer.open) pickFocus(layer, initialFocus); });
  return layer;
}

export const openModal = (opts) => panelLayer('modal', opts);
export const openDrawer = (opts) => panelLayer('drawer', opts);

/* ---------- confirm / prompt ---------- */
export function confirmDialog({ title = 'Подтвердите действие', text, details, confirmLabel = 'Подтвердить', cancelLabel = 'Отмена', danger = false }) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; resolve(value); } };
    const cancel = h('button', { class: 'btn', type: 'button', onclick: () => { finish(false); dlg.close('cancel'); } }, cancelLabel);
    const ok = h('button', { class: cx('btn', danger ? 'danger' : 'primary'), type: 'button', onclick: () => { finish(true); dlg.close('ok'); } }, confirmLabel);
    const dlg = openModal({
      title, size: 'sm', footer: [cancel, ok], onClose: () => finish(false), initialFocus: danger ? cancel : ok,
      body: [text ? h('p', { class: 'dlg-text' }, text) : null, details ?? null]
    });
  });
}

// Single-field dialog. Resolves to the entered string, or null when cancelled.
export function promptDialog({ title, label, hint, value = '', placeholder, confirmLabel = 'Применить', validate, suggestions, allowEmpty = false, danger = false }) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
    const listId = uid('sg');
    const input = textInput({ value, placeholder, list: suggestions?.length ? listId : null, 'data-autofocus': '' });
    const error = h('p', { class: 'form-error', role: 'alert' });
    const form = h('form', { class: 'stack', novalidate: true, onsubmit: (e) => {
      e.preventDefault();
      const v = input.value.trim();
      if (!v && !allowEmpty) { error.textContent = 'Заполните поле'; input.focus(); return; }
      const problem = validate?.(v);
      if (problem) { error.textContent = problem; input.focus(); return; }
      finish(v);
      dlg.close('ok');
    } }, field(label, input, { hint }), suggestions?.length ? h('datalist', { id: listId }, suggestions.map((s) => h('option', { value: s }))) : null, error);
    const formId = uid('pf');
    form.id = formId;
    const dlg = openModal({
      title, size: 'sm', body: form, onClose: () => finish(null), initialFocus: input,
      footer: [h('button', { class: 'btn', type: 'button', onclick: () => dlg.close('cancel') }, 'Отмена'),
        h('button', { class: cx('btn', danger ? 'danger' : 'primary'), type: 'submit', form: formId }, confirmLabel)]
    });
  });
}

/* ---------- popup menu (kebab) ---------- */
let activeMenu = null;
export function openMenu(anchor, items) {
  const toggleOff = activeMenu?.anchor === anchor;
  activeMenu?.close();
  if (toggleOff) return null;
  const buttons = [];
  const menu = h('div', { class: 'menu', role: 'menu' });
  for (const item of items.filter((i) => i && !i.hidden)) {
    if (item.divider) { menu.append(h('div', { class: 'menu-sep', role: 'separator' })); continue; }
    const btn = h('button', {
      class: cx('menu-item', item.danger && 'danger'), type: 'button', role: 'menuitem', disabled: item.disabled, title: item.title,
      onclick: () => { layer.close(); item.onClick?.(); }
    }, item.icon ? icon(item.icon, 15) : h('span', { class: 'ico-gap' }), item.label);
    buttons.push(btn);
    menu.append(btn);
  }
  const outside = (e) => { if (!menu.contains(e.target) && !anchor.contains(e.target)) layer.close(); };
  // A scroll closes the menu only if its anchor really moved (late scroll events from earlier scrolling are ignored).
  let origin = null;
  const dismiss = (e) => {
    if (menu.contains(e.target)) return;
    const r = anchor.isConnected ? anchor.getBoundingClientRect() : null;
    if (!r || Math.abs(r.top - origin.top) > 1 || Math.abs(r.left - origin.left) > 1) layer.close();
  };
  const layer = {
    el: menu, panel: menu, modal: false, dismissable: true, anchor,
    close() {
      if (!removeLayer(layer)) return;
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('scroll', dismiss, true);
      removeEventListener('resize', layer.close);
      anchor.setAttribute('aria-expanded', 'false');
      if (menu.contains(document.activeElement) && anchor.isConnected) anchor.focus({ preventScroll: true });
      if (activeMenu === layer) activeMenu = null;
    }
  };
  menu.addEventListener('keydown', (e) => {
    const enabled = buttons.filter((b) => !b.disabled);
    const index = enabled.indexOf(document.activeElement);
    const move = { ArrowDown: 1, ArrowUp: -1 }[e.key];
    if (move) { e.preventDefault(); enabled[(index + move + enabled.length) % enabled.length]?.focus(); }
    else if (e.key === 'Home') { e.preventDefault(); enabled[0]?.focus(); }
    else if (e.key === 'End') { e.preventDefault(); enabled.at(-1)?.focus(); }
    else if (e.key === 'Tab') layer.close();
  });
  pushLayer(layer);
  activeMenu = layer;
  anchor.setAttribute('aria-expanded', 'true');
  const r = anchor.getBoundingClientRect();
  const left = Math.min(Math.max(8, r.right - menu.offsetWidth), innerWidth - menu.offsetWidth - 8);
  const below = r.bottom + 6;
  const top = below + menu.offsetHeight > innerHeight - 8 ? Math.max(8, r.top - menu.offsetHeight - 6) : below;
  Object.assign(menu.style, { left: `${left}px`, top: `${top}px` });
  origin = anchor.getBoundingClientRect();
  document.addEventListener('pointerdown', outside, true);
  document.addEventListener('scroll', dismiss, true);
  addEventListener('resize', layer.close);
  buttons.find((b) => !b.disabled)?.focus({ preventScroll: true });
  return layer;
}

/* ---------- tabs (panels are built lazily on first show) ---------- */
export function tabs(defs, { active = defs[0]?.id, onChange, label = 'Разделы' } = {}) {
  const base = uid('tabs');
  const list = h('div', { class: 'tabs', role: 'tablist', 'aria-label': label });
  const panelsEl = h('div', { class: 'tab-panels' });
  const buttons = new Map(), panels = new Map(), badges = new Map();
  let current = null;

  function select(id, { focus = false } = {}) {
    if (!buttons.has(id)) return;
    current = id;
    for (const def of defs) {
      const on = def.id === id;
      const btn = buttons.get(def.id), panel = panels.get(def.id);
      btn.setAttribute('aria-selected', String(on));
      btn.tabIndex = on ? 0 : -1;
      panel.hidden = !on;
      if (on && !panel.dataset.built) { panel.dataset.built = '1'; panel.append(def.render()); }
    }
    if (focus) buttons.get(id).focus();
    onChange?.(id);
  }
  for (const def of defs) {
    const badge = h('span', { class: 'tab-badge' }, def.badge ?? '');
    badge.hidden = def.badge === undefined || def.badge === null || def.badge === '';
    badges.set(def.id, badge);
    buttons.set(def.id, h('button', {
      class: 'tab', type: 'button', role: 'tab', id: `${base}-t-${def.id}`, 'aria-controls': `${base}-p-${def.id}`, 'aria-selected': 'false', tabindex: '-1',
      onclick: () => select(def.id)
    }, def.icon ? icon(def.icon, 15) : null, def.label, badge));
    panels.set(def.id, h('div', { class: 'tab-panel', role: 'tabpanel', id: `${base}-p-${def.id}`, 'aria-labelledby': `${base}-t-${def.id}`, hidden: true }));
    list.append(buttons.get(def.id));
    panelsEl.append(panels.get(def.id));
  }
  list.addEventListener('keydown', (e) => {
    const ids = defs.map((d) => d.id);
    const i = ids.indexOf(current);
    const next = { ArrowRight: ids[(i + 1) % ids.length], ArrowLeft: ids[(i - 1 + ids.length) % ids.length], Home: ids[0], End: ids.at(-1) }[e.key];
    if (next) { e.preventDefault(); select(next, { focus: true }); }
  });
  select(active);
  return {
    el: h('div', { class: 'tabs-wrap' }, list, panelsEl), select, panel: (id) => panels.get(id), get active() { return current; },
    setBadge(id, text) { const b = badges.get(id); if (b) { b.textContent = text ?? ''; b.hidden = text === undefined || text === null || text === ''; } }
  };
}

/* ---------- filter chips with counters; update() keeps the nodes (and focus) when the set of chips is unchanged ---------- */
export function chipBar({ items, value, onChange, label }) {
  const el = h('div', { class: 'chips', role: 'group', 'aria-label': label });
  let nodes = new Map(), ids = '';
  function build() {
    nodes = new Map();
    el.replaceChildren(...items.map((item) => {
      const text = h('span', null), count = h('b', null);
      const btn = h('button', { class: 'chip', type: 'button', onclick: () => { if (value !== item.id) { value = item.id; paint(); onChange?.(item.id); } } }, text, count);
      nodes.set(item.id, { btn, text, count });
      return btn;
    }));
  }
  function paint() {
    for (const item of items) {
      const n = nodes.get(item.id);
      n.text.textContent = item.label;
      const has = item.count !== undefined && item.count !== null;
      n.count.hidden = !has;
      if (has) n.count.textContent = String(item.count);
      n.btn.className = cx('chip', item.tone, value === item.id && 'on');
      n.btn.setAttribute('aria-pressed', String(value === item.id));
    }
  }
  function update(nextItems = items, nextValue = value) {
    items = nextItems; value = nextValue;
    const key = items.map((i) => i.id).join('|');
    if (key !== ids) { ids = key; build(); }
    paint();
  }
  update();
  return { el, update };
}

/* ---------- alerts and page states ---------- */
export function alertBox(kind, ...content) {
  const glyph = { err: 'alert', warn: 'alert', info: 'info', ok: 'check' }[kind] ?? 'info';
  return h('div', { class: `alert ${kind}`, role: kind === 'err' ? 'alert' : 'status' }, icon(glyph, 16), h('div', null, ...content));
}
export function emptyState({ glyph = 'search', title, text, actions }) {
  return h('div', { class: 'empty' }, h('div', { class: 'ico-big' }, icon(glyph, 24)), h('h3', null, title), text ? h('p', null, text) : null,
    actions?.length ? h('div', { class: 'row wrap center' }, actions) : null);
}
export function errorState(message, onRetry) {
  return emptyState({
    glyph: 'alert', title: 'Не удалось загрузить данные', text: message,
    actions: onRetry ? [h('button', { class: 'btn', type: 'button', onclick: onRetry }, icon('refresh', 15), 'Повторить')] : null
  });
}
export const loadingBlock = (text = 'Загрузка…') => h('div', { class: 'loading', role: 'status' }, spinner(), text);
export function skeletonRows(count = 8) {
  return h('div', { class: 'skeleton-list', 'aria-hidden': 'true' }, Array.from({ length: count }, () => h('div', { class: 'skeleton-row' }, h('i'), h('i'), h('i'), h('i'))));
}
export function reportError(error, fallback = 'Что-то пошло не так') {
  if (error?.silent) return;
  toast(error?.message || fallback, 'error');
}

/* ---------- theme ---------- */
export const getTheme = () => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
export function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem('zaliv.theme', theme); } catch { /* storage unavailable */ }
}
