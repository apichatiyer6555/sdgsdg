// Defensive defaults: the UI must keep working if the backend omits an optional field.
export const normAccount = (a) => ({
  ...a,
  label: a.label ?? '', login: a.login ?? '', client: a.client ?? '', notes: a.notes ?? '', proxy: a.proxy ?? '',
  statusDetail: a.statusDetail ?? '', lastError: a.lastError ?? '',
  tags: Array.isArray(a.tags) ? a.tags : [], spend7d: Array.isArray(a.spend7d) ? a.spend7d : [],
  adAccountsCount: a.adAccountsCount ?? 0, bcCount: a.bcCount ?? 0, busy: a.busy ?? null, waitingFor: a.waitingFor ?? null
});

export const normAd = (x) => ({
  ...x,
  name: x.name ?? '', bcName: x.bcName ?? '', accountLabel: x.accountLabel ?? '', currency: x.currency ?? '', error: x.error ?? '',
  campaigns: { total: 0, loaded: 0, working: 0, enabled: 0, problem: 0, ...(x.campaigns ?? {}) },
  metrics: { spend: 0, impressions: 0, clicks: 0, conversions: 0, ctr: null, cpc: null, cpa: null, ...(x.metrics ?? {}) },
  reasons: Array.isArray(x.reasons) ? x.reasons : [], needsTopUp: !!x.needsTopUp
});
