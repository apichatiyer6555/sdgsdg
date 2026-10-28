// Form building blocks: field wrapper, selects, password input with eye, tag chips input, switch, checkbox.
import { h, cx, uid } from './dom.js';
import { icon } from './icons.js';

export function field(label, control, { hint, className, forId } = {}) {
  const id = forId ?? (control.id || (control.id = uid('f')));
  return h('div', { class: cx('field', className) },
    label ? h('label', { class: 'label', for: id }, label) : null,
    control,
    hint ? h('p', { class: 'hint' }, hint) : null);
}

export const textInput = (attrs = {}) => h('input', { class: 'input', type: 'text', autocomplete: 'off', spellcheck: 'false', ...attrs });
export const textArea = (attrs = {}) => h('textarea', { class: 'textarea', spellcheck: 'false', ...attrs });

export function selectEl({ options, value = '', onChange, label, className }) {
  const el = h('select', { class: cx('select', className), 'aria-label': label, onchange: (e) => onChange?.(e.target.value) },
    options.map((o) => h('option', { value: o.value }, o.label)));
  el.value = String(value);
  if (el.value !== String(value) && options.length) el.selectedIndex = 0;
  return el;
}

export function passwordField({ value = '', placeholder = '', autocomplete = 'current-password', name, id } = {}) {
  const input = h('input', { class: 'input', type: 'password', value, placeholder, autocomplete, name, id: id ?? uid('pw'), spellcheck: 'false', autocapitalize: 'off' });
  const toggle = h('button', { class: 'icon-btn input-btn', type: 'button', 'aria-pressed': 'false' });
  const draw = (shown) => {
    input.type = shown ? 'text' : 'password';
    toggle.setAttribute('aria-pressed', String(shown));
    toggle.setAttribute('aria-label', shown ? 'Скрыть пароль' : 'Показать пароль');
    toggle.title = shown ? 'Скрыть пароль' : 'Показать пароль';
    toggle.replaceChildren(icon(shown ? 'eye-off' : 'eye', 16));
  };
  toggle.addEventListener('click', () => { draw(input.type === 'password'); input.focus(); });
  draw(false);
  return { el: h('div', { class: 'input-group' }, input, toggle), input };
}

// Chips input: Enter / comma / paste with separators add tags, Backspace on empty removes the last one.
export function tagInput({ value = [], suggestions = [], placeholder = 'Тег и Enter', label = 'Теги', onChange } = {}) {
  let tags = [...value];
  const listId = uid('tags');
  const input = h('input', { class: 'tag-field', type: 'text', placeholder, 'aria-label': label, autocomplete: 'off', list: listId });
  const wrap = h('div', { class: 'tag-input' }, input, h('datalist', { id: listId }, suggestions.map((s) => h('option', { value: s }))));

  const chip = (tag) => h('span', { class: 'tag-chip' }, h('span', null, tag),
    h('button', { type: 'button', 'aria-label': `Убрать тег ${tag}`, onclick: (e) => { e.stopPropagation(); tags = tags.filter((t) => t !== tag); draw(); onChange?.([...tags]); input.focus(); } }, icon('x', 11)));
  function draw() {
    for (const old of wrap.querySelectorAll('.tag-chip')) old.remove();
    for (const tag of tags) wrap.insertBefore(chip(tag), input); // the input node stays in place, so focus is kept
  }
  function commit() {
    const parts = input.value.split(/[,;\n]/).map((s) => s.trim()).filter(Boolean);
    if (!parts.length) { input.value = ''; return; }
    let changed = false;
    for (const part of parts) {
      if (!tags.some((t) => t.toLowerCase() === part.toLowerCase())) { tags.push(part.slice(0, 40)); changed = true; }
    }
    input.value = '';
    draw();
    if (changed) onChange?.([...tags]);
  }
  input.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ',') && !e.isComposing) {
      if (input.value.trim()) { e.preventDefault(); commit(); } else if (e.key === ',') e.preventDefault();
    } else if (e.key === 'Backspace' && !input.value && tags.length) { tags.pop(); draw(); onChange?.([...tags]); }
  });
  input.addEventListener('blur', commit);
  input.addEventListener('paste', (e) => {
    const text = e.clipboardData?.getData('text') ?? '';
    if (/[,;\n]/.test(text)) { e.preventDefault(); input.value += text; commit(); }
  });
  wrap.addEventListener('click', (e) => { if (e.target === wrap) input.focus(); });
  draw();
  return {
    el: wrap, input, commit,
    get value() { commit(); return [...tags]; },
    set value(next) { tags = [...next]; draw(); }
  };
}

export function switchField({ label, hint, checked = false, disabled = false, onChange, id } = {}) {
  const input = h('input', { type: 'checkbox', role: 'switch', checked, disabled, id: id ?? uid('sw'), onchange: (e) => onChange?.(e.target.checked) });
  const el = h('label', { class: 'switch' },
    h('span', { class: 'switch-text' }, h('b', null, label), hint ? h('span', null, hint) : null),
    input, h('span', { class: 'track' }));
  return { el, input };
}

export function checkField({ label, checked = false, hint, disabled = false, id, onChange } = {}) {
  const input = h('input', { type: 'checkbox', checked, disabled, id: id ?? uid('ck'), onchange: (e) => onChange?.(e.target.checked) });
  const el = h('label', { class: 'check' }, input, h('span', null, label, hint ? h('small', { class: 'hint' }, hint) : null));
  return { el, input };
}
