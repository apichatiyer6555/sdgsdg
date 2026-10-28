// Pure helpers: TikTok campaign rows -> normalized campaigns + ad account summary.
// Ported from the TTAds Hub extension (background/lib/reasons.js, explorer/model.js, overview/model.js).

const EXACT = {
  account_balance_not_enough: 'Недостаточно средств',
  balance_not_enough: 'Недостаточно средств',
  insufficient_balance: 'Недостаточно средств',
  campaign_out_of_budget: 'Закончился бюджет',
  adgroup_out_of_budget: 'Закончился бюджет',
  campaign_disable: 'Кампания выключена',
  adgroup_disable: 'Адсет выключен',
  ad_disable: 'Объявление выключено',
  audit: 'На модерации',
  under_review: 'На модерации',
  rejected: 'Отклонено',
  time_done: 'Расписание завершено',
  time_not_start: 'Расписание ещё не началось',
  not_delivery: 'Нет доставки',
  delivery_limited: 'Доставка ограничена'
};

const KIND_LABEL = {
  balance: 'Недостаточно средств', budget: 'Закончился бюджет', rejected: 'Отклонено',
  review: 'На модерации', schedule: 'Проблема с расписанием', off: 'Выключено'
};

// balance | budget | rejected | review | schedule | off | other
export function classifyReason(raw) {
  const r = String(raw ?? '').toLowerCase();
  if (!r) return 'other';
  if (/balance|insufficient|no_fund|nofund|payment/.test(r)) return 'balance';
  if (/out_of_budget|budget/.test(r)) return 'budget';
  if (/reject|disapprov|offline_audit|violation/.test(r)) return 'rejected';
  if (/audit|review|pending/.test(r)) return 'review';
  if (/time_done|time_not_start|schedule/.test(r)) return 'schedule';
  if (/disable|paused|off$/.test(r)) return 'off';
  return 'other';
}

export function reasonText(raw) {
  const key = String(raw ?? '').toLowerCase();
  if (!key) return 'Причина не указана';
  if (EXACT[key]) return EXACT[key];
  const kind = classifyReason(key);
  if (KIND_LABEL[kind]) return KIND_LABEL[kind];
  return key.replaceAll('_', ' ');
}

// Fields requested from TikTok for every campaign row.
export const CAMPAIGN_KEYS = Object.freeze([
  'campaign_id', 'campaign_name', 'name', 'opt_status', 'primary_status', 'campaign_status', 'campaign_status_list',
  'budget_auto_reset_fail_reason', 'campaign_budget', 'budget',
  'stat_cost', 'show_cnt', 'click_cnt', 'time_attr_convert_cnt'
]);

const num = (v) => {
  if (v === null || v === undefined || v === '' || v === '-') return 0;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
};
const str = (v, n = 180) => (v === null || v === undefined ? '' : String(v)).slice(0, n);
const asList = (value) => {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== 'string' || !value.trim()) return [];
  try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed.map(String) : [value]; } catch { return [value]; }
};
const ratio = (a, b, k = 1) => (b > 0 ? (a / b) * k : null);

export function normalizeCampaign(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const id = str(r.campaign_id, 40);
  if (!/^\d{5,30}$/.test(id)) return null;
  const primary = str(r.primary_status, 60);
  const opt = r.opt_status === undefined || r.opt_status === null || r.opt_status === '' ? null : Number(r.opt_status);
  const enabled = opt === null ? (primary ? primary !== 'disable' : null) : opt === 1;
  const reasons = [...new Set([r.campaign_status, ...asList(r.campaign_status_list), r.budget_auto_reset_fail_reason]
    .map((x) => str(x, 80)).filter((x) => x && x !== '-' && x !== primary))].slice(0, 6);
  const working = primary === 'delivery_ok';
  const status = working ? 'working' : enabled === true ? 'issue' : 'off';
  const reasonRaw = reasons[0] || primary;
  const spend = num(r.stat_cost);
  const impressions = num(r.show_cnt);
  const clicks = num(r.click_cnt);
  const conversions = num(r.time_attr_convert_cnt);
  return {
    id, name: str(r.campaign_name ?? r.name ?? id), enabled, status,
    reason: status === 'issue' ? reasonText(reasonRaw) : '',
    reasonKind: status === 'issue' ? classifyReason(reasonRaw) : '',
    budget: num(r.campaign_budget ?? r.budget),
    spend, impressions, clicks, conversions,
    ctr: ratio(clicks, impressions, 100), cpc: ratio(spend, clicks), cpm: ratio(spend, impressions, 1000),
    cpa: ratio(spend, conversions), cvr: ratio(conversions, clicks, 100)
  };
}

export const normalizeCampaigns = (rows) => (Array.isArray(rows) ? rows : []).map(normalizeCampaign).filter(Boolean);

// result: { rows, total, truncated, error } from listObjectsInPage for one advertiser.
export function summarizeAdAccount(result) {
  const empty = {
    state: 'unknown', campaigns: [], counts: { total: 0, loaded: 0, working: 0, enabled: 0, problem: 0 },
    metrics: { spend: 0, impressions: 0, clicks: 0, conversions: 0, ctr: null, cpc: null, cpa: null },
    reasons: [], needsTopUp: false, error: ''
  };
  if (!result || result.error) return { ...empty, state: 'error', error: str(result?.error || 'Нет данных от TikTok', 240) };

  const campaigns = normalizeCampaigns(result.rows);
  const working = campaigns.filter((c) => c.status === 'working').length;
  const problems = campaigns.filter((c) => c.status === 'issue');
  const state = working ? 'delivering' : problems.length ? 'issue' : campaigns.length ? 'paused' : 'empty';

  const byReason = new Map();
  for (const c of problems) {
    const key = c.reason || 'Причина не указана';
    const entry = byReason.get(key) ?? { text: key, kind: c.reasonKind || classifyReason(key), count: 0 };
    entry.count += 1;
    byReason.set(key, entry);
  }
  const sum = (k) => campaigns.reduce((s, c) => s + (c[k] || 0), 0);
  const spend = sum('spend');
  const impressions = sum('impressions');
  const clicks = sum('clicks');
  const conversions = sum('conversions');
  const reasons = [...byReason.values()].sort((a, b) => b.count - a.count).slice(0, 4);
  return {
    state,
    campaigns,
    counts: {
      total: Math.max(num(result.total), campaigns.length), loaded: campaigns.length, working,
      enabled: campaigns.filter((c) => c.enabled === true).length, problem: problems.length
    },
    metrics: { spend, impressions, clicks, conversions, ctr: ratio(clicks, impressions, 100), cpc: ratio(spend, clicks), cpa: ratio(spend, conversions) },
    reasons,
    needsTopUp: reasons.some((r) => r.kind === 'balance'),
    error: ''
  };
}

const pad = (n) => String(n).padStart(2, '0');
const fmtDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export const PERIODS = Object.freeze([
  { id: 'today', days: 1, offset: 0 }, { id: 'yesterday', days: 1, offset: 1 },
  { id: '7d', days: 7, offset: 0 }, { id: '30d', days: 30, offset: 0 }
]);

export function periodRange(periodId = '7d', now = new Date()) {
  const p = PERIODS.find((x) => x.id === periodId) ?? PERIODS.find((x) => x.id === '7d');
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() - p.offset);
  const start = new Date(end.getFullYear(), end.getMonth(), end.getDate() - (p.days - 1));
  return { id: p.id, st: fmtDate(start), et: fmtDate(end) };
}
