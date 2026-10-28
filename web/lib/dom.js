// Tiny DOM builder. Untrusted strings only ever reach the page via text nodes, textContent or setAttribute.
const PROPS = new Set(['value', 'checked', 'disabled', 'hidden', 'selected', 'readOnly', 'indeterminate', 'open']);

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'class') el.className = Array.isArray(value) ? value.filter(Boolean).join(' ') : value;
      else if (key === 'dataset') Object.assign(el.dataset, value);
      else if (key === 'style' && typeof value === 'object') {
        for (const [prop, v] of Object.entries(value)) {
          if (v === undefined || v === null) continue;
          if (prop.startsWith('--')) el.style.setProperty(prop, String(v)); else el.style[prop] = v;
        }
      } else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
      else if (PROPS.has(key)) el[key] = value;
      else el.setAttribute(key, value === true ? '' : String(value));
    }
  }
  append(el, children);
  return el;
}

function append(parent, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) append(parent, child);
    else parent.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
export const cx = (...names) => names.filter(Boolean).join(' ');
export const clear = (el) => { el.replaceChildren(); return el; };
// Replaces the children of el; null/false entries are skipped (native append would stringify them).
export function fill(el, ...children) { el.replaceChildren(); append(el, children); return el; }

let uidCounter = 0;
export const uid = (prefix = 'id') => `${prefix}-${++uidCounter}`;

export function debounce(fn, ms) {
  let timer;
  const wrapped = (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
  wrapped.cancel = () => clearTimeout(timer);
  return wrapped;
}

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch {
    const area = h('textarea', { style: { position: 'fixed', opacity: '0' }, value: text });
    document.body.append(area);
    area.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { /* not available */ }
    area.remove();
    return ok;
  }
}

// toast(message, kind, ms | { ms, action: { label, onClick } })
export function toast(message, kind = 'info', opts = {}) {
  const host = $('#toasts');
  if (!host) return;
  const { ms = kind === 'error' ? 6500 : 3800, action } = typeof opts === 'number' ? { ms: opts } : opts;
  for (const old of [...host.children]) if (old.dataset.msg === message) old.remove();
  while (host.children.length >= 4) host.firstElementChild.remove();
  let timer;
  const dismiss = () => { clearTimeout(timer); el.classList.add('out'); setTimeout(() => el.remove(), 250); };
  const el = h('div', { class: `toast ${kind}`, role: kind === 'error' ? 'alert' : 'status', dataset: { msg: message } },
    h('span', { class: 'toast-msg' }, message),
    action ? h('button', { class: 'toast-act', type: 'button', onclick: () => { dismiss(); action.onClick(); } }, action.label) : null);
  el.addEventListener('mouseenter', () => clearTimeout(timer));
  el.addEventListener('mouseleave', () => { timer = setTimeout(dismiss, 1800); });
  host.append(el);
  timer = setTimeout(dismiss, ms);
}

const pad = (n) => String(n).padStart(2, '0');
export function fmtTime(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '—';
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return new Date().toDateString() === d.toDateString() ? time : `${pad(d.getDate())}.${pad(d.getMonth() + 1)} ${time}`;
}

export function download(filename, data, type = 'application/octet-stream') {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const link = h('a', { href: url, download: filename });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export const plural = (n, one, few, many) => {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
  return many;
};
