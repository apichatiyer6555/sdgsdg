import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { client, findChrome, makeApp, signIn, sleep, waitFor } from './helpers/ctx.js';
import { startMockTikTok } from './helpers/mock-tiktok.js';

const chrome = findChrome();

describe('browser flows against a mock TikTok', { skip: chrome ? false : 'no Chrome/Chromium found' }, () => {
  let mock;
  let env;
  let api;

  const sessionJson = (token) => JSON.stringify([
    { name: 'sessionid', value: token, domain: '127.0.0.1', path: '/', secure: false, httpOnly: true },
    { name: 'csrftoken', value: `csrf-${token}`, domain: '127.0.0.1', path: '/', secure: false }
  ]);
  const account = async (id) => (await api.get(`/api/accounts/${id}`)).body.account;
  const settled = (id, status) => waitFor(async () => { const a = await account(id); return a.status === status && !a.busy ? a : null; }, { message: `account ${id} -> ${status}` });
  const waiting = (id, what) => waitFor(async () => { const a = await account(id); return a.waitingFor === what ? a : null; }, { message: `account ${id} waiting for ${what}` });
  const addPassword = async (login) => (await api.post('/api/accounts', { method: 'password', login, password: 'pw-123456', label: login })).body;

  before(async () => {
    mock = await startMockTikTok();
    env = await makeApp({ TIKTOK_ADS_ORIGIN: mock.origin });
    api = client(env.app, await signIn(env.app));
  });
  after(async () => { await env.close(); await mock.close(); });

  test('session import: check, sync, ad accounts, campaigns, spend', async () => {
    const created = await api.post('/api/accounts', { method: 'session', label: 'Cookie login', session: sessionJson(mock.state.createSession()) });
    assert.equal(created.status, 201);
    const id = created.body.id;

    assert.equal((await api.post(`/api/accounts/${id}/check`)).status, 202);
    const checked = await settled(id, 'active');
    assert.equal(checked.adAccountsCount, 4);
    assert.equal(checked.bcCount, 1);
    assert.ok(checked.lastCheckAt);

    assert.equal((await api.post(`/api/accounts/${id}/sync`)).status, 202);
    const synced = await waitFor(async () => { const a = await account(id); return a.lastSyncAt && !a.busy ? a : null; }, { message: 'sync finished' });
    assert.equal(synced.status, 'active');
    assert.equal(synced.adAccountsCount, 4);
    assert.deepEqual(synced.spend7d.sort((a, b) => a.currency.localeCompare(b.currency)), [{ currency: 'EUR', amount: 12.5 }, { currency: 'USD', amount: 3.2 }]);

    const ads = (await api.get('/api/ad-accounts')).body;
    assert.equal(ads.items.length, 4);
    const by = Object.fromEntries(ads.items.map((a) => [a.id, a]));
    assert.equal(by['7700000000000000001'].state, 'delivering');
    assert.equal(by['7700000000000000001'].needsTopUp, true);
    assert.equal(by['7700000000000000001'].bcName, 'Mock BC');
    assert.equal(by['7700000000000000001'].metrics.spend, 12.5);
    assert.equal(by['7700000000000000002'].state, 'paused');
    assert.equal(by['7700000000000000003'].state, 'empty');
    assert.equal(by['7700000000000000004'].state, 'error');
    assert.match(by['7700000000000000004'].error, /internal error/);
    assert.deepEqual(ads.currencies, ['EUR', 'USD']);
    assert.equal((await api.get(`/api/ad-accounts?state=paused`)).body.items.length, 1);
    assert.equal((await api.get(`/api/ad-accounts?q=shop`)).body.items.length, 1);

    const camp = (await api.get(`/api/ad-accounts/${id}/7700000000000000001/campaigns`)).body;
    assert.equal(camp.items.length, 2);
    assert.deepEqual(camp.items.map((c) => c.status).sort(), ['issue', 'working']);
    assert.equal(camp.items.find((c) => c.status === 'issue').reason, 'Недостаточно средств');
    assert.equal(camp.period.id, '7d');

    const dash = (await api.get('/api/dashboard')).body;
    assert.equal(dash.adAccounts.total, 4);
    assert.equal(dash.adAccounts.error, 1);
    assert.ok(dash.attention.some((a) => a.kind === 'adaccount' && a.adAccountId === '7700000000000000004'));
    const detail = (await api.get(`/api/accounts/${id}`)).body;
    assert.equal(detail.adAccounts.length, 4);
    assert.ok(detail.events.some((e) => e.kind === 'sync.done'));
  });

  test('an unknown or expired session becomes session_expired', async () => {
    const created = await api.post('/api/accounts', { method: 'session', label: 'Dead cookies', session: sessionJson('not-a-valid-token') });
    await api.post(`/api/accounts/${created.body.id}/check`);
    const a = await settled(created.body.id, 'session_expired');
    assert.match(a.statusDetail, /Сессия истекла/);

    const good = await api.post('/api/accounts', { method: 'session', label: 'Will expire', session: sessionJson(mock.state.createSession()) });
    await api.post(`/api/accounts/${good.body.id}/check`);
    await settled(good.body.id, 'active');
    mock.state.expireAll();
    await api.post(`/api/accounts/${good.body.id}/sync`);
    await settled(good.body.id, 'session_expired');
  });

  test('a live login without Ads access stays active with a note', async () => {
    const created = await api.post('/api/accounts', { method: 'session', label: 'No ads access', session: sessionJson(mock.state.createSession({ noads: true })) });
    const id = created.body.id;
    await api.post(`/api/accounts/${id}/check`);
    const a = await settled(id, 'active');
    assert.match(a.statusDetail, /нет доступа к Ads Manager/);
    assert.equal(a.adAccountsCount, 0);
    assert.equal((await api.get(`/api/accounts/${id}`)).body.adAccounts.length, 0);
    await api.post(`/api/accounts/${id}/sync`);
    const synced = await waitFor(async () => { const x = await account(id); return x.lastSyncAt && !x.busy ? x : null; }, { message: 'sync of no-ads login' });
    assert.equal(synced.status, 'active');
    assert.match(synced.statusDetail, /нет доступа к Ads Manager/);
    const kinds = (await api.get(`/api/accounts/${id}`)).body.events.map((e) => e.kind);
    assert.ok(kinds.includes('session.ok'));
  });

  test('password login succeeds, saves the session and syncs', async () => {
    const acc = await addPassword('ok1@x.test');
    const started = await api.post(`/api/accounts/${acc.id}/login`);
    assert.equal(started.status, 202);
    assert.equal(started.body.busy, 'login');
    assert.equal((await api.post(`/api/accounts/${acc.id}/login`)).status, 409);
    const active = await waitFor(async () => { const a = await account(acc.id); return a.status === 'active' && a.lastSyncAt && !a.busy ? a : null; }, { message: 'login + sync' });
    assert.equal(active.hasSession, true);
    assert.ok(active.lastLoginAt);
    assert.equal(active.adAccountsCount, 4);
    const events = (await api.get(`/api/accounts/${acc.id}`)).body.events.map((e) => e.kind);
    assert.ok(events.includes('login.success'));
    assert.equal(env.ctx.pool.interactive.active, 0);
    const exported = (await api.get(`/api/accounts/${acc.id}/session/export`)).body;
    assert.ok(exported.cookies.some((c) => c.name === 'sessionid'));
  });

  test('e-mail code: wrong code is retried, right code finishes', async () => {
    const acc = await addPassword('code1@x.test');
    await api.post(`/api/accounts/${acc.id}/login`);
    const waitingAcc = await waiting(acc.id, 'code');
    assert.equal(waitingAcc.status, 'need_code');

    const info = (await api.get(`/api/accounts/${acc.id}/browser`)).body;
    assert.equal(info.active, true);
    assert.equal(info.kind, 'login');
    assert.ok(info.width >= 1000);
    const shot = await api.get(`/api/accounts/${acc.id}/browser/screenshot`);
    assert.equal(shot.status, 200);
    assert.equal(shot.headers['content-type'], 'image/jpeg');
    assert.deepEqual([...shot.raw.subarray(0, 2)], [0xff, 0xd8]);

    assert.equal((await api.post(`/api/accounts/${acc.id}/code`, { code: '12' })).status, 400);
    assert.equal((await api.post(`/api/accounts/${acc.id}/code`, { code: '000000' })).status, 200);
    await sleep(500);
    const again = await waitFor(async () => { const a = await account(acc.id); return a.waitingFor === 'code' && /не принял/.test(a.statusDetail) ? a : null; }, { message: 'retry prompt' });
    assert.equal(again.status, 'need_code');

    assert.equal((await api.post(`/api/accounts/${acc.id}/code`, { code: '123456' })).status, 200);
    const done = await settled(acc.id, 'active');
    assert.equal(done.hasSession, true);
    assert.equal((await api.post(`/api/accounts/${acc.id}/code`, { code: '123456' })).status, 409);
  });

  test('wrong password is reported as bad_credentials', async () => {
    const acc = await addPassword('bad1@x.test');
    await api.post(`/api/accounts/${acc.id}/login`);
    const a = await settled(acc.id, 'bad_credentials');
    assert.match(a.statusDetail, /Incorrect/);
    assert.equal(a.hasSession, false);
    const changed = await api.patch(`/api/accounts/${acc.id}`, { password: 'another-pass-1' });
    assert.equal(changed.body.status, 'new');
  });

  test('captcha needs the operator: remote click finishes the login', async () => {
    const acc = await addPassword('captcha1@x.test');
    await api.post(`/api/accounts/${acc.id}/login`);
    const a = await waiting(acc.id, 'manual');
    assert.equal(a.status, 'need_manual');
    assert.equal((await api.post(`/api/accounts/${acc.id}/browser/input`, { type: 'click', x: 99999, y: 5 })).status, 400);
    assert.equal((await api.post(`/api/accounts/${acc.id}/browser/input`, { type: 'navigate', url: 'https://evil.example/' })).status, 400);
    assert.equal((await api.post(`/api/accounts/${acc.id}/browser/input`, { type: 'click', x: 170, y: 360 })).status, 204);
    await settled(acc.id, 'active');
  });

  test('cancel stops the login and frees the browser slot', async () => {
    const acc = await addPassword('code2@x.test');
    await api.post(`/api/accounts/${acc.id}/login`);
    await waiting(acc.id, 'code');
    const cancelled = await api.post(`/api/accounts/${acc.id}/cancel`);
    assert.equal(cancelled.status, 200);
    const a = await settled(acc.id, 'new');
    assert.match(a.statusDetail, /отменён/i);
    assert.equal(env.ctx.pool.interactive.active, 0);
    assert.equal(env.ctx.ops.sessions.size, 0);
    assert.equal((await api.get(`/api/accounts/${acc.id}/browser`)).body.active, false);
  });

  test('assist browser: open, navigate, close keeps the session', async () => {
    const created = await api.post('/api/accounts', { method: 'session', label: 'Assist', session: sessionJson(mock.state.createSession()) });
    const id = created.body.id;
    const opened = await api.post(`/api/accounts/${id}/browser/open`, {});
    assert.equal(opened.status, 200);
    assert.equal(opened.body.active, true);
    assert.equal(opened.body.kind, 'assist');
    assert.equal((await account(id)).busy, 'assist');
    await waitFor(async () => (await api.get(`/api/accounts/${id}/browser`)).body.url.includes('/i18n/dashboard'), { message: 'dashboard loaded in assist browser' });
    assert.equal((await api.post(`/api/accounts/${id}/browser/input`, { type: 'navigate', url: `${mock.origin}/i18n/login` })).status, 204);
    assert.equal((await api.post(`/api/accounts/${id}/browser/open`, {})).body.kind, 'assist');
    assert.equal((await api.post(`/api/accounts/${id}/browser/close`)).status, 204);
    assert.equal((await account(id)).busy, null);
    assert.equal(env.ctx.pool.interactive.active, 0);
    await api.post(`/api/accounts/${id}/check`);
    await settled(id, 'active');
  });

  test('scheduler syncs due accounts and restart recovery resets transient statuses', async () => {
    const created = await api.post('/api/accounts', { method: 'session', label: 'Scheduled', session: sessionJson(mock.state.createSession()) });
    const id = created.body.id;
    env.ctx.db.prepare("UPDATE accounts SET status = 'active' WHERE id = ?").run(id);
    env.ctx.settings.update({ autoSyncEnabled: true, syncIntervalMin: 15 });
    await env.ctx.scheduler.tick();
    const a = await waitFor(async () => { const x = await account(id); return x.lastSyncAt && !x.busy ? x : null; }, { message: 'scheduled sync' });
    assert.equal(a.adAccountsCount, 4);
    assert.ok(env.ctx.scheduler.snapshot().lastRunAt);
    env.ctx.settings.update({ autoSyncEnabled: false });

    env.ctx.db.prepare("UPDATE accounts SET status = 'logging_in' WHERE id = ?").run(id);
    assert.ok(env.ctx.ops.recoverStatuses() >= 1);
    assert.equal((await account(id)).status, 'session_expired');
  });

  test('deleting an account removes its data and stops running work', async () => {
    const acc = await addPassword('code3@x.test');
    await api.post(`/api/accounts/${acc.id}/login`);
    await waiting(acc.id, 'code');
    assert.equal((await api.del(`/api/accounts/${acc.id}`)).status, 204);
    assert.equal(env.ctx.pool.interactive.active, 0);
    assert.equal((await api.get(`/api/accounts/${acc.id}`)).status, 404);
  });
});
