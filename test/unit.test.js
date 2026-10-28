import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSession } from '../src/lib/cookies.js';
import { createVault, generatePassword, hashPassword, verifyPassword } from '../src/lib/crypto.js';
import { maskProxy, normalizeProxy, toPlaywrightProxy } from '../src/lib/proxy.js';
import { classifyReason, normalizeCampaign, periodRange, reasonText, summarizeAdAccount } from '../src/lib/tiktok-model.js';

const NOW = Math.floor(Date.now() / 1000);

test('vault encrypts, decrypts and detects tampering', () => {
  const vault = createVault(Buffer.alloc(32, 7));
  const a = vault.encrypt('секрет-pass');
  const b = vault.encrypt('секрет-pass');
  assert.notEqual(a, b);
  assert.equal(vault.decrypt(a), 'секрет-pass');
  assert.equal(vault.encrypt(''), null);
  assert.equal(vault.decrypt(null), '');
  const raw = Buffer.from(a.slice(3), 'base64');
  raw[raw.length - 1] ^= 1;
  assert.throws(() => vault.decrypt(`v1:${raw.toString('base64')}`));
  assert.throws(() => createVault(Buffer.alloc(16)));
});

test('password hashing verifies and rejects', async () => {
  const hash = await hashPassword('correct horse battery');
  assert.match(hash, /^scrypt\$/);
  assert.equal(await verifyPassword('correct horse battery', hash), true);
  assert.equal(await verifyPassword('wrong', hash), false);
  assert.equal(await verifyPassword('x', 'garbage'), false);
  assert.equal(generatePassword(20).length, 20);
});

test('parseSession: Chrome extension JSON array', () => {
  const text = JSON.stringify([
    { name: 'sessionid', value: 'abc', domain: '.tiktok.com', path: '/', expirationDate: NOW + 1000, httpOnly: true, secure: true, sameSite: 'no_restriction' },
    { name: 'csrftoken', value: 'xyz', domain: 'ads.tiktok.com', hostOnly: true, session: true, sameSite: 'lax' },
    { name: 'other', value: '1', domain: '.google.com' },
    { name: 'old', value: '1', domain: '.tiktok.com', expirationDate: NOW - 50 }
  ]);
  const r = parseSession(text);
  assert.equal(r.format, 'json-array');
  assert.deepEqual(r.cookies.map((c) => c.name).sort(), ['csrftoken', 'sessionid']);
  const sid = r.cookies.find((c) => c.name === 'sessionid');
  assert.equal(sid.sameSite, 'None');
  assert.equal(sid.secure, true);
  assert.equal(r.cookies.find((c) => c.name === 'csrftoken').expires, -1);
  assert.equal(r.stats.dropped, 1);
  assert.equal(r.stats.expired, 1);
});

test('parseSession: storageState, Netscape and header formats', () => {
  const state = parseSession(JSON.stringify({ cookies: [{ name: 'sid_tt', value: 'v', domain: '.tiktok.com', path: '/', expires: NOW + 10 }], origins: [{ origin: 'https://ads.tiktok.com', localStorage: [{ name: 'a', value: 'b' }] }] }));
  assert.equal(state.format, 'storage-state');
  assert.equal(state.origins.length, 1);

  const netscape = ['# Netscape HTTP Cookie File', `#HttpOnly_.tiktok.com\tTRUE\t/\tTRUE\t${NOW + 99}\tsessionid\tNS1`, `ads.tiktok.com\tFALSE\t/\tFALSE\t0\tcsrftoken\tNS2`].join('\n');
  const ns = parseSession(netscape);
  assert.equal(ns.format, 'netscape');
  assert.equal(ns.cookies.find((c) => c.name === 'sessionid').httpOnly, true);
  assert.equal(ns.cookies.find((c) => c.name === 'csrftoken').expires, -1);

  const header = parseSession('Cookie: sessionid=H1; csrftoken=H2; ttwid=1%7Cabc');
  assert.equal(header.format, 'header');
  assert.equal(header.cookies.length, 3);
  assert.ok(header.cookies.every((c) => c.domain === '.tiktok.com' && c.secure));
  assert.equal(header.cookies.find((c) => c.name === 'ttwid').value, '1%7Cabc');
});

test('parseSession: errors and local default domain', () => {
  assert.throws(() => parseSession(''), { status: 400 });
  assert.throws(() => parseSession('{"foo": 1}'), { status: 400 });
  assert.throws(() => parseSession('[{"name":"a","value":"b","domain":".example.org"}]'), /tiktok/i);
  assert.throws(() => parseSession(JSON.stringify([{ name: 'a', value: 'b', domain: '.tiktok.com', expirationDate: NOW - 5 }])), /просрочен/);
  const local = parseSession('sessionid=1', { defaultDomain: '127.0.0.1', extraHosts: ['127.0.0.1'] });
  assert.equal(local.cookies[0].domain, '127.0.0.1');
  assert.ok(parseSession('foo=bar').warnings.some((w) => /авторизации/.test(w)));
});

test('proxy normalization, masking and Playwright mapping', () => {
  assert.equal(normalizeProxy(''), '');
  assert.equal(normalizeProxy('1.2.3.4:8080'), 'http://1.2.3.4:8080');
  assert.equal(normalizeProxy('1.2.3.4:8080:user:pass'), 'http://user:pass@1.2.3.4:8080');
  assert.equal(normalizeProxy('socks5://5.6.7.8:1080'), 'socks5://5.6.7.8:1080');
  assert.throws(() => normalizeProxy('socks5://u:p@5.6.7.8:1080'), /SOCKS/);
  assert.throws(() => normalizeProxy('ftp://x:1'), { status: 400 });
  assert.throws(() => normalizeProxy('http://nohostport'), { status: 400 });
  assert.equal(maskProxy('http://user:pass@h.example:3128'), 'http://user:***@h.example:3128');
  assert.deepEqual(toPlaywrightProxy('http://user:p%40ss@h.example:3128'), { server: 'http://h.example:3128', username: 'user', password: 'p@ss' });
  assert.equal(toPlaywrightProxy(''), undefined);
});

test('reason classification and texts', () => {
  assert.equal(classifyReason('account_balance_not_enough'), 'balance');
  assert.equal(classifyReason('campaign_out_of_budget'), 'budget');
  assert.equal(classifyReason('ad_offline_audit'), 'rejected');
  assert.equal(classifyReason('under_review'), 'review');
  assert.equal(classifyReason('time_not_start'), 'schedule');
  assert.equal(classifyReason('campaign_disable'), 'off');
  assert.equal(classifyReason(''), 'other');
  assert.equal(reasonText('insufficient_balance'), 'Недостаточно средств');
  assert.equal(reasonText(''), 'Причина не указана');
  assert.equal(reasonText('some_new_reason'), 'some new reason');
});

test('campaign normalization and ad account summary', () => {
  const working = normalizeCampaign({ campaign_id: '7701000000000000001', campaign_name: 'A', primary_status: 'delivery_ok', opt_status: 1, stat_cost: '10', show_cnt: '1000', click_cnt: '50', time_attr_convert_cnt: '5', campaign_budget: '30' });
  assert.equal(working.status, 'working');
  assert.equal(working.ctr, 5);
  assert.equal(working.cpa, 2);
  const issue = normalizeCampaign({ campaign_id: '7701000000000000002', primary_status: 'not_delivery', opt_status: 1, campaign_status: 'account_balance_not_enough' });
  assert.equal(issue.status, 'issue');
  assert.equal(issue.reasonKind, 'balance');
  const off = normalizeCampaign({ campaign_id: '7701000000000000003', primary_status: 'disable', opt_status: 2 });
  assert.equal(off.status, 'off');
  assert.equal(normalizeCampaign({ campaign_id: 'bad' }), null);

  const rows = [
    { campaign_id: '7701000000000000001', primary_status: 'delivery_ok', opt_status: 1, stat_cost: '10', show_cnt: '100', click_cnt: '10', time_attr_convert_cnt: '1' },
    { campaign_id: '7701000000000000002', primary_status: 'not_delivery', opt_status: 1, campaign_status: 'account_balance_not_enough' }
  ];
  const s = summarizeAdAccount({ rows, total: 2 });
  assert.equal(s.state, 'delivering');
  assert.equal(s.needsTopUp, true);
  assert.deepEqual(s.counts, { total: 2, loaded: 2, working: 1, enabled: 2, problem: 1 });
  assert.equal(s.metrics.spend, 10);
  assert.equal(summarizeAdAccount({ rows: [] }).state, 'empty');
  assert.equal(summarizeAdAccount({ rows: [rows[1]] }).state, 'issue');
  assert.equal(summarizeAdAccount({ rows: [{ campaign_id: '7701000000000000003', primary_status: 'disable', opt_status: 2 }] }).state, 'paused');
  const err = summarizeAdAccount({ error: 'boom' });
  assert.equal(err.state, 'error');
  assert.equal(err.error, 'boom');
});

test('periodRange covers the requested window', () => {
  const now = new Date(2026, 9, 28, 12);
  assert.deepEqual(periodRange('7d', now), { id: '7d', st: '2026-10-22', et: '2026-10-28' });
  assert.deepEqual(periodRange('yesterday', now), { id: 'yesterday', st: '2026-10-27', et: '2026-10-27' });
  assert.equal(periodRange('nope', now).id, '7d');
});
