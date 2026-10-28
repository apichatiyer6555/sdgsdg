// Functions below run INSIDE the TikTok page (Playwright page.evaluate serializes each one, so they must be
// self-contained: no imports, no closures). Request contracts come from the TTAds Hub extension (archive TTAds-Hub-1.5.0).

// GET /api/v2/i18n/account/account_switch_list/ — ad accounts and Business Centers visible to the login.
export async function listAccountsInPage(arg) {
  try {
    const { origin, expected = '' } = arg || {};
    if (location.origin !== origin) return { ok: false, kind: 'page', message: `Открыта страница ${location.origin}, ожидали ${origin}.` };
    const current = new URL(location.href).searchParams.get('aadvid') || expected || '';
    const csrf = decodeURIComponent(document.cookie.match(/(?:^|;\s*)csrftoken=([^;]+)/)?.[1] || '');
    const headers = { accept: 'application/json, text/plain, */*' };
    if (csrf) { headers['x-csrftoken'] = csrf; headers['x-secsdk-csrf-token'] = csrf; }
    const suffix = current ? `?aadvid=${encodeURIComponent(current)}` : '';
    const response = await fetch(`/api/v2/i18n/account/account_switch_list/${suffix}`, { credentials: 'include', headers, signal: AbortSignal.timeout(20000) });
    if (/\/login/i.test(response.url)) return { ok: false, kind: 'auth', status: response.status, message: 'TikTok перенаправил на страницу входа.' };
    let data = null;
    try { data = JSON.parse(await response.text()); } catch { data = null; }
    if (response.status === 401) return { ok: false, kind: 'auth', status: 401, message: 'HTTP 401' };
    if (!data || typeof data !== 'object') return { ok: false, kind: response.status >= 500 ? 'http' : 'api', status: response.status, message: `TikTok вернул HTTP ${response.status}` };
    if (data.code !== 0) {
      const msg = String(data.msg || data.message || '');
      const key = String(data.extra?.i18n_key || '');
      const auth = data.code === 40002 || /PERMISSION|LOGIN|AUTH|SESSION/i.test(key) || /permission|log ?in|not auth|session|expired/i.test(msg);
      return { ok: false, kind: auth ? 'auth' : 'api', status: response.status, code: data.code, message: msg.slice(0, 200) || `code ${data.code}` };
    }

    const isId = (v) => /^\d{5,30}$/.test(String(v ?? ''));
    const byId = new Map();
    const centers = new Map();
    const add = (item, bc) => {
      if (!isId(item?.id)) return;
      byId.set(String(item.id), {
        id: String(item.id), name: String(item.name || item.id).slice(0, 160), country: String(item.country || '').slice(0, 8),
        currency: String(item.currency || '').slice(0, 8), status: Number(item.status),
        bcId: bc ? String(bc.id) : '', businessCenter: bc ? String(bc.name).slice(0, 160) : ''
      });
    };
    for (const item of Array.isArray(data?.data?.data) ? data.data.data : []) {
      const children = Array.isArray(item?.child) ? item.child : [];
      const isCenter = children.length > 0 || String(item?.role) === '99';
      if (isCenter) {
        const bc = isId(item?.id) ? { id: String(item.id), name: String(item.name || item.id) } : null;
        if (bc) centers.set(bc.id, { id: bc.id, name: bc.name.slice(0, 160), accountCount: children.length });
        for (const child of children) add(child, bc);
      } else if (item?.country || item?.currency) {
        add(item, null);
      }
    }
    if (!byId.size && isId(current)) add({ id: current, name: current }, null);
    const accounts = [...byId.values()];
    return { ok: true, currentAccount: current, accounts: accounts.slice(0, 2000), businessCenters: [...centers.values()].slice(0, 500), total: accounts.length };
  } catch (e) {
    return { ok: false, kind: 'network', message: String(e?.message || e).slice(0, 240) };
  }
}

// POST /api/v4/i18n/statistics/op/campaign/list/ for several advertisers (paged, limited concurrency).
export async function listCampaignsInPage(spec) {
  try {
    const { origin, st, et, pageSize = 200, maxRows = 200, concurrency = 3 } = spec || {};
    if (location.origin !== origin) return { ok: false, kind: 'page', message: `Открыта страница ${location.origin}, ожидали ${origin}.` };
    const ids = (Array.isArray(spec.ids) ? spec.ids : []).map(String).filter((id) => /^\d{5,30}$/.test(id));
    const keys = Array.isArray(spec.keys) ? spec.keys : [];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(st)) || !/^\d{4}-\d{2}-\d{2}$/.test(String(et))) return { ok: false, kind: 'api', message: 'Некорректный период.' };
    const csrf = decodeURIComponent(document.cookie.match(/(?:^|;\s*)csrftoken=([^;]+)/)?.[1] || '');
    const headers = { accept: 'application/json, text/plain, */*', 'content-type': 'application/json;charset=UTF-8', 'app-name': '@tt4b-vmok/campaign-list' };
    if (csrf) { headers['x-csrftoken'] = csrf; headers['x-secsdk-csrf-token'] = csrf; }
    const finite = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
    const project = (raw) => {
      const row = { ...(raw || {}), ...(raw?.row_data || {}), ...(raw?.stat_data || {}), ...(raw?.custom_metrics || {}) };
      const out = {};
      for (const key of keys) {
        const value = row[key];
        if (value === undefined || value === null) continue;
        out[key] = typeof value === 'object' ? JSON.stringify(value).slice(0, 400) : value;
      }
      return out;
    };

    async function loadOne(id) {
      const rows = [];
      let total = 0;
      try {
        for (let page = 1; ; page++) {
          const body = {
            common_req: {
              metrics: ['stat_cost', 'show_cnt', 'click_cnt', 'time_attr_convert_cnt', 'learning_phase', 'learning_phase_detail', 'campaign_budget', 'budget_auto_adjust_is_enabled', 'campaign_live_toggle', 'campaign_is_live_use'],
              st, et, lifetime: 0, compare_st: '', compare_et: '', sort_stat: 'create_time', sort_order: 1,
              dimensions: ['campaign_id'], filters: [{ field: 'campaign_platform_status', filter_type: 0, in_field_values: ['999'] }], page, page_size: pageSize
            },
            extra: {
              get_compare_value: '0', get_compare_rate: '0', get_compare_diff: '0', scene: 'campaign_list_v2', list_version: 'v2',
              page_view_scene: 'view_non_first', region_schedule: '1', ab_primary_status: 'v2', enable_status_action: 1,
              request_id: crypto.randomUUID(), request_count: 2, fe_source: 'zaliv'
            }
          };
          const response = await fetch(`/api/v4/i18n/statistics/op/campaign/list/?aadvid=${encodeURIComponent(id)}`, {
            method: 'POST', credentials: 'include', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(25000)
          });
          let data;
          try { data = JSON.parse(await response.text()); } catch { throw Object.assign(new Error(`TikTok вернул HTTP ${response.status}`), { kind: 'http' }); }
          if (typeof data === 'string') throw Object.assign(new Error(data.slice(0, 200)), { kind: /csrf/i.test(data) ? 'csrf' : 'api' });
          if (!response.ok || data?.code !== 0) {
            const msg = String(data?.msg || data?.message || `HTTP ${response.status}`);
            const auth = data?.code === 40002 || response.status === 401 || /permission|log ?in|session|expired/i.test(msg);
            throw Object.assign(new Error(msg.slice(0, 200)), { kind: auth ? 'auth' : 'api' });
          }
          const table = Array.isArray(data?.data?.table) ? data.data.table : [];
          for (const raw of table) rows.push(project(raw));
          total = finite(data?.data?.pagination?.total_count) || rows.length;
          const pages = finite(data?.data?.pagination?.page_count) || Math.ceil(total / pageSize);
          if (!table.length || page >= pages || rows.length >= maxRows) break;
        }
        return { id, rows: rows.slice(0, maxRows), total, truncated: total > Math.min(rows.length, maxRows) };
      } catch (e) {
        return { id, rows: [], total: 0, truncated: false, error: String(e?.message || e).slice(0, 240), kind: e?.kind || 'network' };
      }
    }

    const results = new Array(ids.length);
    let cursor = 0;
    const worker = async () => { while (cursor < ids.length) { const index = cursor++; results[index] = await loadOne(ids[index]); } };
    await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), ids.length || 1) }, worker));
    return { ok: true, results };
  } catch (e) {
    return { ok: false, kind: 'network', message: String(e?.message || e).slice(0, 240) };
  }
}

// Classifies what the login page shows right now. Called repeatedly by the login flow.
export function detectLoginState() {
  const vis = (e) => {
    if (!e) return false;
    const r = e.getBoundingClientRect();
    const s = getComputedStyle(e);
    return r.width > 1 && r.height > 1 && s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
  };
  const text = (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 3000);
  const onLogin = /\/(login|signin|sso)(\/|$)/i.test(location.pathname);
  const inputs = [...document.querySelectorAll('input')].filter(vis);
  const hasForm = inputs.some((i) => i.type === 'password') && inputs.some((i) => i.type === 'email' || i.name === 'email');
  const codeInput = inputs.find((i) => i.type !== 'password' && i.type !== 'email' && (
    /verification code|enter (the )?code|security code|6-digit|one-time/i.test(i.placeholder || '') || (i.name === 'text' && /code/i.test(i.placeholder || ''))));
  if (codeInput) codeInput.setAttribute('data-zaliv-code', '1');
  const codeText = /verification code|enter the code|code (was )?sent|we('| ha)ve sent/i.test(text) && !hasForm;
  const capEl = document.querySelector('#captcha_container, .captcha_verify_container, .captcha-verify-container, [class*="captcha" i], iframe[src*="captcha" i]');
  const captcha = (capEl && vis(capEl)) || /drag the (slider|puzzle)|slide to complete|verify you are human|select (2|two) objects|click on the shapes|security verification/i.test(text);
  const errNodes = [...document.querySelectorAll('[class*="error" i], [role="alert"], [class*="toast" i], [class*="notice" i]')]
    .filter(vis).map((e) => (e.innerText || '').trim()).filter((t) => t && t.length < 220);
  const errorText = errNodes.find((t) => /incorrect|wrong|invalid|not match|doesn.t exist|does not exist|not registered|too many|try again|locked|frozen|suspend|banned|failed|not found|error/i.test(t)) || '';
  return {
    onLogin, hasForm, code: !!(codeInput || codeText), codeInput: !!codeInput, captcha: !!captcha, errorText: errorText.slice(0, 200),
    url: location.href.slice(0, 200), title: document.title.slice(0, 120)
  };
}
