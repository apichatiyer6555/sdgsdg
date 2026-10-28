import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { PASSWORD, client, makeApp, signIn } from './helpers/ctx.js';

describe('panel API', () => {
  let env;
  let owner;
  let api;
  const SECRET_PASSWORD = 'S3cret-Tik-Pass!';
  const SECRET_COOKIE = 'cookie-secret-value-123';

  before(async () => {
    env = await makeApp();
    owner = await signIn(env.app);
    api = client(env.app, owner);
  });
  after(async () => { await env.close(); });

  test('health is public, API requires a session', async () => {
    const health = await env.app.inject({ url: '/healthz' });
    assert.equal(health.statusCode, 200);
    const res = await client(env.app).get('/api/accounts');
    assert.equal(res.status, 401);
    assert.equal(res.body.code, 'unauthorized');
  });

  test('login: wrong password, cookie flags, csrf enforcement, security headers', async () => {
    const bad = await env.app.inject({ method: 'POST', url: '/api/auth/login', payload: { login: 'admin', password: 'nope-nope-nope' } });
    assert.equal(bad.statusCode, 401);
    assert.equal(bad.json().code, 'invalid_credentials');

    const ok = await env.app.inject({ method: 'POST', url: '/api/auth/login', payload: { login: 'ADMIN', password: PASSWORD } });
    assert.equal(ok.statusCode, 200);
    assert.match(ok.headers['set-cookie'], /HttpOnly/);
    assert.match(ok.headers['set-cookie'], /SameSite=Lax/i);
    assert.equal(ok.json().user.role, 'owner');
    assert.match(ok.headers['content-security-policy'], /default-src 'self'/);
    assert.equal(ok.headers['cache-control'], 'no-store');

    const me = await api.get('/api/auth/me');
    assert.equal(me.status, 200);
    assert.equal(me.body.csrf, owner.csrf);

    const noCsrf = await env.app.inject({ method: 'POST', url: '/api/accounts', headers: { cookie: owner.cookie }, payload: {} });
    assert.equal(noCsrf.statusCode, 403);
    assert.equal(noCsrf.json().code, 'csrf');
    const badOrigin = await env.app.inject({ method: 'POST', url: '/api/accounts/bulk', headers: { cookie: owner.cookie, 'x-csrf-token': owner.csrf, origin: 'https://evil.example' }, payload: {} });
    assert.equal(badOrigin.statusCode, 403);
  });

  test('accounts: create, validate, duplicate, patch, never leak secrets', async () => {
    const created = await api.post('/api/accounts', { method: 'password', login: 'buyer1@mail.test', password: SECRET_PASSWORD, label: 'Buyer 1', client: 'Acme', tags: ['vip', 'eu', 'VIP'], proxy: '1.2.3.4:8080:puser:ppass' });
    assert.equal(created.status, 201);
    const acc = created.body;
    assert.equal(acc.status, 'new');
    assert.equal(acc.hasPassword, true);
    assert.equal(acc.hasSession, false);
    assert.deepEqual(acc.tags, ['vip', 'eu']);
    assert.equal(acc.proxy, 'http://puser:***@1.2.3.4:8080');

    assert.equal((await api.post('/api/accounts', { method: 'password', login: 'BUYER1@mail.test', password: 'x' })).status, 409);
    assert.equal((await api.post('/api/accounts', { method: 'password', login: 'a@b.c' })).status, 400);
    assert.equal((await api.post('/api/accounts', { method: 'password', login: 'p@b.c', password: 'x', proxy: 'ftp://bad:1' })).status, 400);
    assert.equal((await api.post('/api/accounts', { method: 'session', session: 'not json at all but no cookie either' })).status, 400);

    const patched = await api.patch(`/api/accounts/${acc.id}`, { label: 'Renamed', notes: 'vip client', proxy: '', disabled: true });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.label, 'Renamed');
    assert.equal(patched.body.proxy, '');
    assert.equal(patched.body.status, 'disabled');
    await api.patch(`/api/accounts/${acc.id}`, { disabled: false });

    const list = await api.get('/api/accounts');
    assert.equal(list.status, 200);
    assert.ok(list.body.items.some((a) => a.id === acc.id));
    assert.deepEqual(list.body.clients, ['Acme']);
    assert.ok(!JSON.stringify(list.body).includes(SECRET_PASSWORD));
    const detail = await api.get(`/api/accounts/${acc.id}`);
    assert.ok(!JSON.stringify(detail.body).includes(SECRET_PASSWORD));
    assert.ok(detail.body.events.some((e) => e.kind === 'account.create'));
    const dbRow = env.ctx.db.prepare('SELECT password_enc FROM accounts WHERE id = ?').get(acc.id);
    assert.ok(dbRow.password_enc.startsWith('v1:') && !dbRow.password_enc.includes(SECRET_PASSWORD));

    assert.equal((await api.get('/api/accounts?q=renamed')).body.items.length, 1);
    assert.equal((await api.get('/api/accounts?q=zzzz-none')).body.items.length, 0);
    assert.equal((await api.get('/api/accounts?tag=EU')).body.items.length, 1);
    assert.equal((await api.get('/api/accounts/9999')).status, 404);
    assert.equal((await api.get('/api/accounts/abc')).status, 400);
  });

  test('accounts: session import, replace, export permissions', async () => {
    const created = await api.post('/api/accounts', { method: 'session', label: 'Cookie acc', session: `sessionid=${SECRET_COOKIE}; csrftoken=abc` });
    assert.equal(created.status, 201);
    assert.equal(created.body.hasSession, true);
    assert.equal(created.body.method, 'session');
    assert.ok(!JSON.stringify(created.body).includes(SECRET_COOKIE));
    const id = created.body.id;

    const replaced = await api.post(`/api/accounts/${id}/session`, { session: JSON.stringify([{ name: 'sessionid', value: 'new-value', domain: '.tiktok.com', secure: true }]) });
    assert.equal(replaced.status, 200);
    const exported = await api.get(`/api/accounts/${id}/session/export`);
    assert.equal(exported.status, 200);
    assert.equal(exported.body.cookies[0].value, 'new-value');
    assert.ok(env.ctx.db.prepare('SELECT 1 FROM events WHERE kind = ?').get('session.export'));

    const adminUser = await api.post('/api/users', { login: 'manager', password: 'Manager-Pass-123', role: 'admin' });
    assert.equal(adminUser.status, 201);
    assert.equal(adminUser.body.mustChangePassword, true);
    env.ctx.db.prepare('UPDATE users SET must_change_password = 0 WHERE login = ?').run('manager');
    const managerApi = client(env.app, await signIn(env.app, 'manager', 'Manager-Pass-123'));
    assert.equal((await managerApi.get(`/api/accounts/${id}/session/export`)).status, 403);
    assert.equal((await managerApi.get('/api/users')).status, 403);
    assert.equal((await managerApi.get('/api/accounts')).status, 200);
    assert.equal((await managerApi.post('/api/accounts', { method: 'password', login: 'm1@x.test', password: 'pw' })).status, 201);
  });

  test('accounts: line import handles formats, duplicates and errors', async () => {
    const text = ['# comment', 'imp1@mail.test:pass:1', 'imp2@mail.test;pass2;http://u:p@9.9.9.9:3128;t1,t2;ClientX', 'imp3@mail.test|pass3', 'broken-line-without-password', 'imp1@mail.test:again', ''].join('\n');
    const res = await api.post('/api/accounts/import', { text, tags: ['batch'], client: 'Default client' });
    assert.equal(res.status, 200);
    assert.equal(res.body.created, 3);
    assert.equal(res.body.skipped, 1);
    assert.equal(res.body.errors.length, 1);
    assert.equal(res.body.errors[0].line, 5);
    const list = (await api.get('/api/accounts?q=imp2@')).body.items[0];
    assert.deepEqual(list.tags, ['batch', 't1', 't2']);
    assert.equal(list.client, 'ClientX');
    assert.equal(list.proxy, 'http://u:***@9.9.9.9:3128');
    assert.equal((await api.get('/api/accounts?q=imp1@')).body.items[0].client, 'Default client');
    const imp1 = (await api.get('/api/accounts?q=imp1@')).body.items[0];
    const full = env.ctx.accounts.credentials(imp1.id);
    assert.equal(full.password, 'pass:1');
  });

  test('accounts: bulk actions', async () => {
    const ids = (await api.get('/api/accounts?q=imp')).body.items.map((a) => a.id);
    assert.ok(ids.length >= 3);
    const tag = await api.post('/api/accounts/bulk', { ids, action: 'tag', value: 'bulk-tag' });
    assert.deepEqual(tag.body.failed, []);
    assert.ok((await api.get('/api/accounts?tag=bulk-tag')).body.items.length >= 3);
    await api.post('/api/accounts/bulk', { ids, action: 'set_client', value: 'Bulk Client' });
    assert.equal((await api.get(`/api/accounts/${ids[0]}`)).body.account.client, 'Bulk Client');
    await api.post('/api/accounts/bulk', { ids: [ids[0]], action: 'disable' });
    assert.equal((await api.get(`/api/accounts/${ids[0]}`)).body.account.status, 'disabled');
    const failedCheck = await api.post('/api/accounts/bulk', { ids: [ids[1]], action: 'check' });
    assert.equal(failedCheck.body.failed.length, 1);
    assert.match(failedCheck.body.failed[0].error, /сессии/);
    assert.equal((await api.post('/api/accounts/bulk', { ids: [], action: 'tag' })).status, 400);
    assert.equal((await api.post('/api/accounts/bulk', { ids, action: 'explode' })).status, 400);
    const del = await api.post('/api/accounts/bulk', { ids, action: 'delete' });
    assert.equal(del.body.ok.length, ids.length);
    assert.equal((await api.get(`/api/accounts/${ids[0]}`)).status, 404);
  });

  test('operations on accounts without prerequisites fail clearly', async () => {
    const acc = (await api.post('/api/accounts', { method: 'session', label: 'S', session: 'sessionid=x' })).body;
    assert.equal((await api.post(`/api/accounts/${acc.id}/login`)).status, 400);
    const noSession = (await api.post('/api/accounts', { method: 'password', login: 'nosess@x.test', password: 'p' })).body;
    assert.equal((await api.post(`/api/accounts/${noSession.id}/sync`)).status, 400);
    assert.equal((await api.post(`/api/accounts/${noSession.id}/code`, { code: '123456' })).status, 409);
    assert.equal((await api.get(`/api/accounts/${noSession.id}/browser`)).body.active, false);
    assert.equal((await api.get(`/api/accounts/${noSession.id}/browser/screenshot`)).status, 404);
  });

  test('dashboard, ad accounts, journal, settings, system', async () => {
    const dash = await api.get('/api/dashboard');
    assert.equal(dash.status, 200);
    assert.ok(dash.body.accounts.total >= 1);
    assert.ok(Array.isArray(dash.body.attention));
    assert.ok(dash.body.recentEvents.length > 0);
    assert.equal(typeof dash.body.sync.autoEnabled, 'boolean');
    const ads = await api.get('/api/ad-accounts');
    assert.deepEqual(ads.body.items, []);
    assert.equal((await api.get('/api/ad-accounts/1/12345678/campaigns')).status, 404);
    const journal = await api.get('/api/journal?limit=5');
    assert.equal(journal.body.items.length, 5);
    assert.equal(journal.body.hasMore, true);
    const more = await api.get(`/api/journal?limit=5&before=${journal.body.items.at(-1).id}`);
    assert.ok(more.body.items[0].id < journal.body.items.at(-1).id);
    assert.equal((await api.get('/api/settings')).body.autoSyncEnabled, false);
    assert.equal((await api.put('/api/settings', { autoSyncEnabled: true, syncIntervalMin: 30 })).body.syncIntervalMin, 30);
    assert.equal((await api.put('/api/settings', { syncIntervalMin: 5 })).status, 400);
    const sys = await api.get('/api/system');
    assert.equal(sys.body.browser.interactive.max, 6);
    assert.equal(typeof sys.body.counts.accounts, 'number');
    assert.equal((await api.post('/api/system/sync-all')).status, 202);
  });

  test('viewer is read-only; disabled user cannot sign in; last owner is protected', async () => {
    const created = await api.post('/api/users', { login: 'viewer1', password: 'Viewer-Pass-123', role: 'viewer' });
    env.ctx.db.prepare('UPDATE users SET must_change_password = 0 WHERE login = ?').run('viewer1');
    const viewer = client(env.app, await signIn(env.app, 'viewer1', 'Viewer-Pass-123'));
    assert.equal((await viewer.get('/api/accounts')).status, 200);
    assert.equal((await viewer.post('/api/accounts', { method: 'password', login: 'v@x.test', password: 'p' })).status, 403);
    assert.equal((await viewer.put('/api/settings', { autoSyncEnabled: true })).status, 403);
    assert.equal((await viewer.get('/api/accounts/1/browser')).status, 403);
    assert.equal((await viewer.get('/api/accounts/1/browser/screenshot')).status, 403);

    await api.patch(`/api/users/${created.body.id}`, { disabled: true });
    const res = await env.app.inject({ method: 'POST', url: '/api/auth/login', payload: { login: 'viewer1', password: 'Viewer-Pass-123' } });
    assert.equal(res.statusCode, 401);
    assert.equal((await viewer.get('/api/accounts')).status, 401);

    const me = await api.get('/api/auth/me');
    assert.equal((await api.del(`/api/users/${me.body.user.id}`)).status, 400);
    assert.equal((await api.patch(`/api/users/${me.body.user.id}`, { role: 'admin' })).status, 400);
  });

  test('forced password change and login throttling', async () => {
    const fresh = await makeApp();
    try {
      fresh.ctx.db.prepare('UPDATE users SET must_change_password = 1').run();
      const session = await signIn(fresh.app);
      const c = client(fresh.app, session);
      assert.equal(session.user.mustChangePassword, true);
      const blocked = await c.get('/api/accounts');
      assert.equal(blocked.status, 403);
      assert.equal(blocked.body.code, 'must_change_password');
      assert.equal((await c.post('/api/auth/change-password', { currentPassword: 'wrong-wrong-1', newPassword: 'New-Password-123' })).status, 400);
      assert.equal((await c.post('/api/auth/change-password', { currentPassword: PASSWORD, newPassword: 'short' })).status, 400);
      assert.equal((await c.post('/api/auth/change-password', { currentPassword: PASSWORD, newPassword: 'New-Password-123' })).status, 204);
      assert.equal((await c.get('/api/accounts')).status, 200);
      assert.equal((await fresh.app.inject({ method: 'POST', url: '/api/auth/login', payload: { login: 'admin', password: PASSWORD } })).statusCode, 401);

      let last;
      for (let i = 0; i < 9; i++) last = await fresh.app.inject({ method: 'POST', url: '/api/auth/login', payload: { login: 'admin', password: `bad-password-${i}` } });
      assert.equal(last.statusCode, 429);
      assert.ok(Number(last.headers['retry-after']) > 0);
      const stillBlocked = await fresh.app.inject({ method: 'POST', url: '/api/auth/login', payload: { login: 'admin', password: 'New-Password-123' } });
      assert.equal(stillBlocked.statusCode, 429);
    } finally { await fresh.close(); }
  });

  test('daily backup: one copy per day, a restart does not add another', async () => {
    const b = await makeApp({ BACKUP_ENABLED: 'true' });
    try {
      await b.ctx.scheduler.tick();
      const { readdirSync } = await import('node:fs');
      assert.equal(readdirSync(b.ctx.config.backupDir).filter((f) => f.endsWith('.db')).length, 1);
      await b.ctx.scheduler.tick();
      assert.equal(readdirSync(b.ctx.config.backupDir).filter((f) => f.endsWith('.db')).length, 1);
      const { Scheduler } = await import('../src/jobs/scheduler.js');
      const restarted = new Scheduler({ config: b.ctx.config, db: b.ctx.db, settings: b.ctx.settings, ops: b.ctx.ops, events: b.ctx.events, panelSessions: b.ctx.panelSessions });
      await restarted.tick();
      assert.equal(readdirSync(b.ctx.config.backupDir).filter((f) => f.endsWith('.db')).length, 1);
    } finally { await b.close(); }
  });

  test('logout invalidates the session', async () => {
    const s = await signIn(env.app);
    const c = client(env.app, s);
    assert.equal((await c.post('/api/auth/logout')).status, 204);
    assert.equal((await c.get('/api/auth/me')).status, 401);
  });

  test('static shell is served', async () => {
    const res = await env.app.inject({ url: '/' });
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'], /text\/html/);
    assert.equal(res.headers['cache-control'], 'no-cache');
    assert.match(res.headers['content-security-policy'], /script-src 'self'/);
    assert.equal((await env.app.inject({ url: '/missing.js' })).statusCode, 404);
  });
});
