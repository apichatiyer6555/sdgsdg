// Labels, tones and chip builders for every status in the API. Color is always paired with text and a glyph.
import { h, cx } from './dom.js';
import { icon } from './icons.js';

export const ACCOUNT_STATUS = {
  new: { label: 'Новый', tone: 'muted', hint: 'Сессии ещё нет: войдите по паролю или вставьте cookies' },
  logging_in: { label: 'Вход…', tone: 'info', spin: true },
  need_code: { label: 'Нужен код', tone: 'warn', glyph: 'mail' },
  need_manual: { label: 'Нужно вмешательство', tone: 'warn', glyph: 'alert' },
  checking: { label: 'Проверка…', tone: 'info', spin: true },
  active: { label: 'Активен', tone: 'ok', glyph: 'check' },
  session_expired: { label: 'Сессия истекла', tone: 'warn', glyph: 'clock' },
  bad_credentials: { label: 'Неверный пароль', tone: 'err', glyph: 'x' },
  error: { label: 'Ошибка', tone: 'err', glyph: 'x' },
  disabled: { label: 'Отключён', tone: 'muted', glyph: 'pause' }
};
export const BUSY_LABEL = { login: 'Вход…', check: 'Проверка…', sync: 'Синхронизация…', assist: 'Удалённый браузер' };
export const STATUS_ORDER = ['need_code', 'need_manual', 'bad_credentials', 'session_expired', 'error', 'new', 'logging_in', 'checking', 'active', 'disabled'];

// Status filter chips of the accounts screen. `attention` is reachable from the dashboard only.
export const ATTENTION_STATUSES = ['need_code', 'need_manual', 'new', 'session_expired', 'bad_credentials', 'error'];
export const STATUS_FILTERS = [
  { id: 'all', label: 'Все', statuses: null },
  { id: 'active', label: 'Активные', statuses: ['active'] },
  { id: 'need_code', label: 'Нужен код', statuses: ['need_code'], tone: 'warn' },
  { id: 'need_manual', label: 'Нужно вмешательство', statuses: ['need_manual'], tone: 'warn' },
  { id: 'relogin', label: 'Требуют входа', statuses: ['new', 'session_expired', 'bad_credentials'] },
  { id: 'error', label: 'Ошибки', statuses: ['error'], tone: 'err' },
  { id: 'disabled', label: 'Отключены', statuses: ['disabled'] }
];
export const ATTENTION_FILTER = { id: 'attention', label: 'Требуют внимания', statuses: ATTENTION_STATUSES, tone: 'warn' };

export const AD_STATE = {
  delivering: { label: 'Работает', tone: 'ok', glyph: 'check' },
  issue: { label: 'Не доставляется', tone: 'warn', glyph: 'alert' },
  paused: { label: 'Выключено', tone: 'info', glyph: 'pause' },
  empty: { label: 'Нет рекламы', tone: 'muted', glyph: 'minus' },
  error: { label: 'Ошибка', tone: 'err', glyph: 'x' },
  unknown: { label: '—', tone: 'muted' }
};
export const AD_STATE_ORDER = ['error', 'issue', 'empty', 'unknown', 'paused', 'delivering'];
export const AD_FILTERS = [
  { id: 'all', label: 'Все' },
  { id: 'delivering', label: 'Работают' },
  { id: 'issue', label: 'Проблемы', tone: 'warn' },
  { id: 'paused', label: 'Выключены' },
  { id: 'empty', label: 'Нет рекламы' },
  { id: 'error', label: 'Ошибка', tone: 'err' }
];

export const CAMPAIGN_STATUS = {
  working: { label: 'Работает', tone: 'ok', glyph: 'check' },
  issue: { label: 'Проблема', tone: 'warn', glyph: 'alert' },
  off: { label: 'Выключена', tone: 'info', glyph: 'pause' }
};
export const REASON_TONE = { balance: 'err', budget: 'warn', rejected: 'err', review: 'info', schedule: 'warn', off: 'muted', other: 'muted' };
export const LEVEL = {
  info: { label: 'Инфо', tone: 'info' },
  warn: { label: 'Предупреждение', tone: 'warn' },
  error: { label: 'Ошибка', tone: 'err' }
};
export const ROLE_LABEL = { owner: 'Владелец', admin: 'Администратор', viewer: 'Наблюдатель' };

export const spinner = () => h('span', { class: 'spinner', 'aria-hidden': 'true' });

export function pill(text, tone = 'muted', { glyph, spin, title, className } = {}) {
  return h('span', { class: cx('pill', tone, className), title },
    spin ? spinner() : glyph ? icon(glyph, 11) : null, text);
}

export function accountStatusChip(a) {
  const meta = ACCOUNT_STATUS[a.status] ?? { label: String(a.status), tone: 'muted' };
  return pill(meta.label, meta.tone, { glyph: meta.glyph, spin: meta.spin, title: a.statusDetail || meta.hint || '' });
}
export const adStateChip = (state) => {
  const meta = AD_STATE[state] ?? AD_STATE.unknown;
  return pill(meta.label, meta.tone, { glyph: meta.glyph });
};
export const campaignChip = (status) => {
  const meta = CAMPAIGN_STATUS[status] ?? { label: String(status), tone: 'muted' };
  return pill(meta.label, meta.tone, { glyph: meta.glyph });
};
export const levelChip = (level) => {
  const meta = LEVEL[level] ?? { label: String(level), tone: 'muted' };
  return pill(meta.label, meta.tone);
};
