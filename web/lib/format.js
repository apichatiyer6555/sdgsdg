// Number / date formatting for the UI (ru-RU: thin spaces between thousands, decimal comma).
import { h } from './dom.js';

const cache = new Map();
function formatter(digits) {
  let f = cache.get(digits);
  if (!f) { f = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: digits, maximumFractionDigits: digits }); cache.set(digits, f); }
  return f;
}
const isNil = (v) => v === null || v === undefined || (typeof v === 'number' && Number.isNaN(v));

export const num = (v, digits = 0) => (isNil(v) ? '—' : formatter(digits).format(v));
export const money = (v, currency = '', digits = 2) => (isNil(v) ? '—' : `${formatter(digits).format(v)} ${currency}`.trim());
export const pct = (v, digits = 2) => (isNil(v) ? '—' : `${formatter(digits).format(v)}%`);
// Money[] -> ["1 234,50 USD", ...]; empty list -> ["—"]
export const moneyParts = (list) => (Array.isArray(list) && list.length ? list.map((m) => money(m.amount, m.currency)) : ['—']);

const toMs = (value) => (typeof value === 'number' ? value : Date.parse(value));

// Intl formatters are expensive to create: keep one of each (toLocaleString per call is ~10x slower).
const dateTimeFmt = new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const dateFmt = new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
export function fmtDateTime(value) {
  const t = toMs(value);
  return Number.isFinite(t) ? dateTimeFmt.format(t) : '—';
}
export function fmtDate(value) {
  const t = toMs(value);
  return Number.isFinite(t) ? dateFmt.format(t) : '—';
}

// «5 мин назад» / «через 2 ч»
export function rel(value, now = Date.now()) {
  const t = toMs(value);
  if (!Number.isFinite(t)) return '—';
  const diff = Math.round((now - t) / 1000);
  const future = diff < 0;
  const s = Math.abs(diff);
  if (s < 45) return future ? 'через минуту' : 'только что';
  const m = Math.round(s / 60);
  const unit = (n, suffix) => (future ? `через ${n} ${suffix}` : `${n} ${suffix} назад`);
  if (m < 60) return unit(m, 'мин');
  const hrs = Math.round(m / 60);
  if (hrs < 24) return unit(hrs, 'ч');
  const days = Math.round(hrs / 24);
  if (days < 45) return unit(days, 'дн');
  return fmtDate(t);
}

export function uptime(sec) {
  if (!Number.isFinite(sec)) return '—';
  const d = Math.floor(sec / 86400), hrs = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  if (d) return `${d} д ${hrs} ч`;
  if (hrs) return `${hrs} ч ${m} мин`;
  return `${Math.max(1, m)} мин`;
}

// <time> element that keeps its «N мин назад» text fresh via one shared ticker.
export function relTime(value, { empty = '—' } = {}) {
  const t = toMs(value);
  if (!Number.isFinite(t)) return h('span', { class: 'muted' }, empty);
  return h('time', { class: 'rel', dataset: { ts: t } }, rel(t));
}

// The absolute date shows as a tooltip; it is formatted on first hover, not for every row up front.
document.addEventListener('mouseover', (e) => {
  const el = e.target instanceof Element ? e.target.closest('time.rel') : null;
  if (el && !el.title) { el.title = fmtDateTime(Number(el.dataset.ts)); el.dateTime = new Date(Number(el.dataset.ts)).toISOString(); }
});

let ticker = 0;
export function startRelTicker() {
  if (ticker) return;
  ticker = setInterval(() => {
    if (document.hidden) return;
    const now = Date.now();
    for (const el of document.querySelectorAll('time.rel[data-ts]')) {
      const text = rel(Number(el.dataset.ts), now);
      if (el.textContent !== text) el.textContent = text;
    }
  }, 30000);
}

// Client-side CSV: ';' delimiter, decimal comma, UTF-8 BOM (Excel-friendly), guard against formula injection.
export function csvCell(value) {
  if (value === null || value === undefined) return '';
  let s;
  if (typeof value === 'number') s = Number.isFinite(value) ? String(value).replace('.', ',') : '';
  else {
    s = String(value);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  }
  return /[";\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}
export function toCsv(rows, columns) {
  const head = columns.map((c) => csvCell(c.title)).join(';');
  const body = rows.map((row) => columns.map((c) => csvCell(c.value(row))).join(';'));
  return `\uFEFF${[head, ...body].join('\r\n')}\r\n`;
}
