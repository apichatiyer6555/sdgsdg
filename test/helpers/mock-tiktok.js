// Local stand-in for ads.tiktok.com: same login DOM, same API shapes (shapes taken from the TTAds Hub extension).
import { randomBytes } from 'node:crypto';
import http from 'node:http';

const ADVERTISERS = {
  '7700000000000000001': { name: 'Shop EU', currency: 'EUR', country: 'DE' },
  '7700000000000000002': { name: 'Paused Offer', currency: 'USD', country: 'US' },
  '7700000000000000003': { name: 'Fresh Account', currency: 'USD', country: 'US' },
  '7700000000000000004': { name: 'Broken API', currency: 'USD', country: 'US' }
};

const CAMPAIGNS = {
  '7700000000000000001': [
    { campaign_id: '7701000000000000001', campaign_name: 'Prospecting', primary_status: 'delivery_ok', opt_status: 1, stat_cost: '12.5', show_cnt: '1000', click_cnt: '50', time_attr_convert_cnt: '5', campaign_budget: '30' },
    { campaign_id: '7701000000000000002', campaign_name: 'Retargeting', primary_status: 'not_delivery', opt_status: 1, campaign_status: 'account_balance_not_enough', stat_cost: '0', show_cnt: '0', click_cnt: '0', time_attr_convert_cnt: '0', campaign_budget: '10' }
  ],
  '7700000000000000002': [
    { campaign_id: '7701000000000000003', campaign_name: 'Old test', primary_status: 'disable', opt_status: 2, stat_cost: '3.2', show_cnt: '200', click_cnt: '4', time_attr_convert_cnt: '0', campaign_budget: '5' }
  ],
  '7700000000000000003': []
};

const page = (body, script = '') => `<!doctype html><html><head><meta charset="utf-8"><title>TikTok Ads: Mock</title>
<style>body{font:14px sans-serif;margin:30px} .login-btn{display:block;margin:10px 0;width:200px;height:40px} .bui-form-item-explain-error{color:#c00}
#captcha{position:fixed;left:40px;top:260px;width:320px;height:140px;background:#eee;border:1px solid #999} #solve{position:absolute;left:60px;top:80px;width:140px;height:40px}</style></head><body>${body}<script>${script}</script></body></html>`;

const LOGIN_HTML = page(`
<h1>Log in to your TikTok for Business account</h1>
<div id="main">
  <label>Email</label><br><input type="email" name="email" placeholder="Enter your email address"><br>
  <label>Password</label><br><input type="password" name="password" placeholder="Enter your password"><br>
  <button type="button" class="login-btn">Log in</button>
  <button type="button" class="auth-btn">Log in with TikTok</button>
</div>
<div id="code-step" style="display:none"><p>We sent a verification code to your email.</p>
  <input type="text" name="text" placeholder="Enter verification code"><button type="button" id="verify">Verify</button></div>
<div id="captcha" class="captcha_verify_container" style="display:none">Drag the slider to verify<button type="button" id="solve">Solve</button></div>
<div class="bui-form-item-explain-error" id="err"></div>`, `
const $ = (s) => document.querySelector(s);
const show = (id, on) => { $(id).style.display = on ? 'block' : 'none'; };
async function post(url, body) { const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return r.json(); }
function handle(res) {
  $('#err').textContent = '';
  if (res.status === 'ok') { location.href = '/i18n/dashboard'; return; }
  if (res.status === 'code') { show('#main', false); show('#code-step', true); return; }
  if (res.status === 'captcha') { show('#main', false); show('#captcha', true); return; }
  if (res.status === 'bad_code') { $('#err').textContent = 'Verification code is incorrect'; return; }
  $('#err').textContent = res.message || 'Error';
}
$('.login-btn').addEventListener('click', async () => handle(await post('/passport/login', { email: $('input[name=email]').value, password: $('input[name=password]').value })));
$('#verify').addEventListener('click', async () => handle(await post('/passport/verify', { code: $('input[name=text]').value })));
$('#solve').addEventListener('click', async () => handle(await post('/passport/captcha', {})));
`);

export async function startMockTikTok() {
  const sessions = new Map(); // token -> flags ({ noads } | {})
  const state = {
    requests: [],
    listFails: false,
    createSession(flags = {}) { const t = randomBytes(12).toString('hex'); sessions.set(t, flags); return t; },
    expireAll() { sessions.clear(); }
  };

  const readBody = (req) => new Promise((resolve) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => resolve(b)); });
  const cookies = (req) => Object.fromEntries(String(req.headers.cookie || '').split(';').map((c) => c.trim().split(/=(.*)/s).slice(0, 2)).filter((p) => p[0]));
  const json = (res, status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
  const sessionFlags = (req) => sessions.get(cookies(req).sessionid);
  const authed = (req) => sessions.has(cookies(req).sessionid);
  const sessionCookies = (t) => [`sessionid=${t}; Path=/; HttpOnly`, `csrftoken=csrf-${t}; Path=/`];

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    state.requests.push(`${req.method} ${url.pathname}`);
    if (url.pathname === '/i18n/login' || url.pathname === '/i18n/login/') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(LOGIN_HTML); }
    if (url.pathname === '/i18n/dashboard') {
      if (!authed(req)) { res.writeHead(302, { location: `/i18n/login/?redirect=${encodeURIComponent(url.pathname)}` }); return res.end(); }
      res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': [`csrftoken=csrf-${cookies(req).sessionid}; Path=/`] });
      return res.end(page('<h1>Ads Manager dashboard</h1>'));
    }
    if (url.pathname === '/passport/login') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const local = String(body.email || '').split('@')[0];
      if (body.password === 'wrong' || local.startsWith('bad')) return json(res, 200, { status: 'error', message: 'Incorrect account or password' });
      if (local.startsWith('code')) return json(res, 200, { status: 'code' });
      if (local.startsWith('captcha')) return json(res, 200, { status: 'captcha' });
      res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': sessionCookies(state.createSession()) });
      return res.end(JSON.stringify({ status: 'ok' }));
    }
    if (url.pathname === '/passport/verify' || url.pathname === '/passport/captcha') {
      const body = JSON.parse((await readBody(req)) || '{}');
      if (url.pathname === '/passport/verify' && body.code !== '123456') return json(res, 200, { status: 'bad_code' });
      res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': sessionCookies(state.createSession()) });
      return res.end(JSON.stringify({ status: 'ok' }));
    }
    if (url.pathname === '/api/v2/i18n/account/account_switch_list/') {
      if (!authed(req)) return json(res, 200, { msg: 'permission error.', code: 40002, data: {}, extra: { i18n_key: 'KEY_PERMISSION_ERROR', type: 'core_user_failure' } });
      if (sessionFlags(req)?.noads) return json(res, 200, { msg: 'permission error.', code: 40002, data: {}, extra: { i18n_key: 'KEY_PERMISSION_ERROR', type: 'core_user_failure' } });
      if (state.listFails) return json(res, 500, { msg: 'internal error', code: 50000 });
      const child = Object.entries(ADVERTISERS).map(([id, a]) => ({ id, name: a.name, country: a.country, currency: a.currency, status: 1 }));
      return json(res, 200, { code: 0, msg: 'OK', data: { data: [{ id: '7600000000000000001', name: 'Mock BC', role: '99', child }] } });
    }
    if (url.pathname === '/passport/web/account/info/') {
      if (!authed(req)) return json(res, 200, { code: 1000001, message: 'session expired', data: {} });
      return json(res, 200, { code: 20000, message: 'success', data: { user_id: '7666000000000000999', user_name: 'mock_user' } });
    }
    if (url.pathname === '/api/v4/i18n/statistics/op/campaign/list/' && req.method === 'POST') {
      await readBody(req);
      const c = cookies(req);
      if (!req.headers['x-csrftoken'] || req.headers['x-csrftoken'] !== c.csrftoken) {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
        return res.end('"no csrf token present in data"');
      }
      if (!authed(req)) return json(res, 200, { msg: 'permission error.', code: 40002, data: {} });
      const id = url.searchParams.get('aadvid');
      if (id === '7700000000000000004') return json(res, 200, { code: 50000, msg: 'internal error' });
      const table = CAMPAIGNS[id] || [];
      return json(res, 200, { code: 0, data: { table, pagination: { total_count: table.length, page_count: 1 } } });
    }
    res.writeHead(404);
    res.end('not found');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    origin: `http://127.0.0.1:${port}`, host: '127.0.0.1', state,
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); })
  };
}
