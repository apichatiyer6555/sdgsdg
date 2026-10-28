import { nowIso } from '../db/index.js';
import { notFound } from '../lib/errors.js';
import { periodRange } from '../lib/tiktok-model.js';

const ratio = (a, b, k = 1) => (b > 0 ? (a / b) * k : null);
const parse = (text, fallback) => { try { return JSON.parse(text); } catch { return fallback; } };
const round2 = (n) => Math.round(n * 100) / 100;

export class AdAccountService {
  constructor({ db, accounts }) {
    this.db = db;
    this.accounts = accounts;
  }

  static dto(row, label) {
    return {
      accountId: row.account_id, accountLabel: label || `Аккаунт ${row.account_id}`,
      id: row.advertiser_id, name: row.name || row.advertiser_id, country: row.country, currency: row.currency, status: row.status,
      bcId: row.bc_id, bcName: row.bc_name, state: row.state,
      campaigns: { total: row.campaigns_total, loaded: row.campaigns_loaded, working: row.campaigns_working, enabled: row.campaigns_enabled, problem: row.campaigns_problem },
      metrics: {
        spend: round2(row.spend), impressions: row.impressions, clicks: row.clicks, conversions: row.conversions,
        ctr: ratio(row.clicks, row.impressions, 100), cpc: ratio(row.spend, row.clicks), cpa: ratio(row.spend, row.conversions)
      },
      reasons: parse(row.reasons, []), needsTopUp: !!row.needs_top_up, error: row.error, syncedAt: row.synced_at
    };
  }

  #labels() {
    const map = new Map();
    for (const r of this.db.prepare('SELECT id, label, login FROM accounts').all()) map.set(r.id, r.label || r.login || `Аккаунт ${r.id}`);
    return map;
  }

  list({ q = '', state = '', accountId = '', bcId = '', currency = '' } = {}) {
    const labels = this.#labels();
    const all = this.db.prepare('SELECT * FROM ad_accounts ORDER BY synced_at DESC, name').all();
    const needle = String(q).trim().toLowerCase();
    const items = [];
    const bcs = new Map();
    const currencies = new Set();
    for (const row of all) {
      if (row.bc_id) bcs.set(row.bc_id, row.bc_name || row.bc_id);
      if (row.currency) currencies.add(row.currency);
      if (state && row.state !== state) continue;
      if (accountId && String(row.account_id) !== String(accountId)) continue;
      if (bcId && row.bc_id !== String(bcId)) continue;
      if (currency && row.currency !== currency) continue;
      const dto = AdAccountService.dto(row, labels.get(row.account_id));
      if (needle && !`${dto.name} ${dto.id} ${dto.bcName} ${dto.bcId} ${dto.accountLabel}`.toLowerCase().includes(needle)) continue;
      items.push(dto);
    }
    const spend = new Map();
    for (const it of items) {
      if (it.state === 'error' || !it.currency) continue;
      spend.set(it.currency, (spend.get(it.currency) || 0) + it.metrics.spend);
    }
    return {
      items,
      period: this.#period(),
      totals: { spend: [...spend].map(([currency, amount]) => ({ currency, amount: round2(amount) })) },
      bcs: [...bcs].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, 'ru')),
      currencies: [...currencies].sort()
    };
  }

  #period() {
    const row = this.db.prepare("SELECT period, period_st AS st, period_et AS et FROM ad_accounts WHERE period_st != '' ORDER BY synced_at DESC LIMIT 1").get();
    return row ? { id: row.period, st: row.st, et: row.et } : periodRange('7d');
  }

  campaigns(accountId, advertiserId) {
    const row = this.db.prepare('SELECT * FROM ad_accounts WHERE account_id = ? AND advertiser_id = ?').get(accountId, String(advertiserId));
    if (!row) throw notFound('Рекламный кабинет не найден.');
    const items = this.db.prepare('SELECT * FROM campaigns WHERE account_id = ? AND advertiser_id = ? ORDER BY spend DESC, name').all(accountId, String(advertiserId)).map((c) => ({
      id: c.campaign_id, name: c.name, status: c.status, enabled: c.enabled === null ? null : !!c.enabled,
      reason: c.reason, reasonKind: c.reason_kind, budget: c.budget, spend: round2(c.spend),
      impressions: c.impressions, clicks: c.clicks, conversions: c.conversions,
      ctr: ratio(c.clicks, c.impressions, 100), cpc: ratio(c.spend, c.clicks), cpm: ratio(c.spend, c.impressions, 1000),
      cpa: ratio(c.spend, c.conversions), cvr: ratio(c.conversions, c.clicks, 100)
    }));
    return {
      adAccount: AdAccountService.dto(row, this.#labels().get(accountId)), items,
      period: { id: row.period, st: row.period_st, et: row.period_et }, syncedAt: row.synced_at
    };
  }

  forAccount(accountId) {
    const label = this.#labels().get(accountId);
    return this.db.prepare('SELECT * FROM ad_accounts WHERE account_id = ? ORDER BY name').all(accountId).map((r) => AdAccountService.dto(r, label));
  }

  /**
   * Persist one sync run for a login.
   * input: { businessCenters: [{id,name,accountCount}], list: [{id,name,country,currency,status,bcId,businessCenter}],
   *          summaries: Map<advertiserId, summarizeAdAccount() result>, period: {id,st,et} }
   */
  saveSync(accountId, { businessCenters, list, summaries, period }) {
    const at = nowIso();
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM business_centers WHERE account_id = ?').run(accountId);
      const insBc = this.db.prepare('INSERT INTO business_centers (account_id, bc_id, name, account_count, synced_at) VALUES (?, ?, ?, ?, ?)');
      for (const bc of businessCenters) insBc.run(accountId, String(bc.id), bc.name || '', bc.accountCount || 0, at);

      const keep = new Set(list.map((a) => String(a.id)));
      for (const row of this.db.prepare('SELECT advertiser_id FROM ad_accounts WHERE account_id = ?').all(accountId)) {
        if (!keep.has(row.advertiser_id)) this.db.prepare('DELETE FROM ad_accounts WHERE account_id = ? AND advertiser_id = ?').run(accountId, row.advertiser_id);
      }

      const upInfo = this.db.prepare(`INSERT INTO ad_accounts (account_id, advertiser_id, name, country, currency, status, bc_id, bc_name)
        VALUES (@accountId, @id, @name, @country, @currency, @status, @bcId, @bcName)
        ON CONFLICT(account_id, advertiser_id) DO UPDATE SET name = excluded.name, country = excluded.country, currency = excluded.currency,
          status = excluded.status, bc_id = excluded.bc_id, bc_name = excluded.bc_name`);
      const upStats = this.db.prepare(`UPDATE ad_accounts SET state = @state, campaigns_total = @total, campaigns_loaded = @loaded, campaigns_working = @working,
        campaigns_enabled = @enabled, campaigns_problem = @problem, spend = @spend, impressions = @impressions, clicks = @clicks, conversions = @conversions,
        reasons = @reasons, needs_top_up = @needsTopUp, error = @error, period = @period, period_st = @st, period_et = @et, synced_at = @at
        WHERE account_id = @accountId AND advertiser_id = @id`);
      const delCampaigns = this.db.prepare('DELETE FROM campaigns WHERE account_id = ? AND advertiser_id = ?');
      const insCampaign = this.db.prepare(`INSERT INTO campaigns (account_id, advertiser_id, campaign_id, name, status, enabled, reason, reason_kind, budget, spend, impressions, clicks, conversions, synced_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      const lastHist = this.db.prepare('SELECT ts, spend FROM ad_account_history WHERE account_id = ? AND advertiser_id = ? ORDER BY ts DESC LIMIT 1');
      const insHist = this.db.prepare('INSERT INTO ad_account_history (account_id, advertiser_id, ts, period, spend, impressions, clicks, conversions) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');

      for (const info of list) {
        const id = String(info.id);
        upInfo.run({ accountId, id, name: info.name || id, country: info.country || '', currency: info.currency || '', status: Number.isFinite(info.status) ? info.status : null, bcId: info.bcId || '', bcName: info.businessCenter || '' });
        const s = summaries.get(id);
        if (!s) continue;
        upStats.run({
          accountId, id, state: s.state, total: s.counts.total, loaded: s.counts.loaded, working: s.counts.working, enabled: s.counts.enabled, problem: s.counts.problem,
          spend: s.metrics.spend, impressions: s.metrics.impressions, clicks: s.metrics.clicks, conversions: s.metrics.conversions,
          reasons: JSON.stringify(s.reasons), needsTopUp: s.needsTopUp ? 1 : 0, error: s.error || '', period: period.id, st: period.st, et: period.et, at
        });
        if (s.state === 'error') continue; // keep previous campaigns when this run failed for the advertiser
        delCampaigns.run(accountId, id);
        for (const c of s.campaigns) insCampaign.run(accountId, id, c.id, c.name, c.status, c.enabled === null ? null : c.enabled ? 1 : 0, c.reason, c.reasonKind, c.budget, c.spend, c.impressions, c.clicks, c.conversions, at);
        const last = lastHist.get(accountId, id);
        if (!last || Date.now() - Date.parse(last.ts) > 50 * 60_000 || last.spend !== s.metrics.spend) {
          insHist.run(accountId, id, at, period.id, s.metrics.spend, s.metrics.impressions, s.metrics.clicks, s.metrics.conversions);
        }
      }
    });
    tx();
    return { adAccounts: list.length, businessCenters: businessCenters.length };
  }

  summary() {
    const counts = this.db.prepare("SELECT state, COUNT(*) AS n FROM ad_accounts GROUP BY state").all();
    const by = Object.fromEntries(counts.map((r) => [r.state, r.n]));
    const camp = this.db.prepare('SELECT COALESCE(SUM(campaigns_total),0) AS total, COALESCE(SUM(campaigns_working),0) AS working, COALESCE(SUM(campaigns_problem),0) AS problem FROM ad_accounts').get();
    const spend = this.db.prepare("SELECT currency, SUM(spend) AS amount FROM ad_accounts WHERE state != 'error' AND currency != '' GROUP BY currency ORDER BY amount DESC").all();
    const labels = this.#labels();
    const attention = this.db.prepare("SELECT * FROM ad_accounts WHERE state IN ('issue','error') ORDER BY needs_top_up DESC, spend DESC LIMIT 60").all().map((row) => {
      const dto = AdAccountService.dto(row, labels.get(row.account_id));
      const text = dto.state === 'error' ? dto.error || 'Не удалось получить данные' : dto.reasons.map((r) => `${r.text} ×${r.count}`).join(', ') || 'Не доставляется';
      return { kind: 'adaccount', accountId: dto.accountId, adAccountId: dto.id, title: dto.name, state: dto.state, text, accountLabel: dto.accountLabel, needsTopUp: dto.needsTopUp };
    });
    return {
      adAccounts: {
        total: counts.reduce((s, r) => s + r.n, 0), delivering: by.delivering || 0, issue: by.issue || 0, paused: by.paused || 0,
        empty: by.empty || 0, error: by.error || 0
      },
      campaigns: { total: camp.total, working: camp.working, problem: camp.problem },
      spend7d: spend.map((r) => ({ currency: r.currency, amount: round2(r.amount) })),
      attention
    };
  }

  totals() {
    return {
      adAccounts: this.db.prepare('SELECT COUNT(*) AS n FROM ad_accounts').get().n,
      campaigns: this.db.prepare('SELECT COUNT(*) AS n FROM campaigns').get().n
    };
  }
}
