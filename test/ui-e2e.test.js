import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { chromium } from 'playwright-core';
import { PASSWORD, client, findChrome, makeApp, signIn, waitFor } from './helpers/ctx.js';
import { startMockTikTok } from './helpers/mock-tiktok.js';

const chrome = findChrome();
const NEW_PASSWORD = 'Better-Panel-Pass-77';
const SHOTS = process.env.SHOTS_DIR || '';

// The real SPA (web/) against the real server and a mock TikTok. Needs Chrome/Chromium.
describe('UI against the real server', { skip: chrome ? false : 'no Chrome/Chromium found' }, () => {
  let mock; let env; let browser; let page; let base; let api;
  const problems = [];

  const sessionJson = (token) => JSON.stringify([
    { name: 'sessionid', value: token, domain: '127.0.0.1', path: '/', secure: false, httpOnly: true },
    { name: 'csrftoken', value: `csrf-${token}`, domain: '127.0.0.1', path: '/', secure: false }
  ]);
  const shot = async (name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }); } };
  const go = async (hash) => { await page.evaluate((h) => { location.hash = h; }, hash); await page.waitForTimeout(200); };
  const rowFor = (text) => page.locator('.accounts-table tbody tr:not(.v-spacer)', { hasText: text }).first();
  const addButton = () => page.locator('.toolbar .btn.primary', { hasText: 'Добавить' });
  const submit = () => page.locator('.panel.modal button[type=submit]').click();
  const statusOf = (text, status, timeout = 40_000) => rowFor(text).locator('.pill', { hasText: status }).first().waitFor({ timeout });

  const closeLayers = async () => {
    for (let i = 0; i < 3 && (await page.locator('#layers > *').count()); i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(250); }
  };

  async function addPasswordAccount(login) {
    await closeLayers();
    await go('#/accounts');
    await addButton().click();
    await page.waitForSelector('.panel.modal');
    await page.locator('.panel.modal input[type=text]').first().fill(login);
    await page.locator('.panel.modal input[type=password]').fill('Tik-Pass-123456');
    await submit();
    await page.waitForSelector('.panel.modal', { state: 'detached' });
    await rowFor(login).waitFor();
  }

  before(async () => {
    mock = await startMockTikTok();
    env = await makeApp({ TIKTOK_ADS_ORIGIN: mock.origin });
    env.ctx.db.prepare('UPDATE users SET must_change_password = 1').run();
    await env.app.listen({ host: '127.0.0.1', port: 0 });
    base = `http://127.0.0.1:${env.app.server.address().port}`;
    browser = await chromium.launch({ executablePath: chrome, args: ['--no-sandbox'] });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'ru-RU' });
    page = await context.newPage();
    page.on('console', (m) => { if (m.type() === 'error') problems.push(`console.error: ${m.text()} @ ${m.location().url}`); });
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    page.on('requestfailed', (r) => problems.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`));
  });

  after(async () => {
    await browser?.close();
    await env?.close();
    await mock?.close();
  });

  test('sign in and the forced password change', async () => {
    await page.goto(base);
    await page.waitForSelector('.auth-card');
    await shot('real-01-login');
    await page.fill('input[name=login]', 'admin');
    await page.fill('input[name=password]', PASSWORD);
    await page.keyboard.press('Enter');
    await page.waitForSelector('text=Смените пароль');
    await page.getByPlaceholder('Текущий пароль').fill(PASSWORD);
    await page.getByPlaceholder('Не короче 10 символов').fill(NEW_PASSWORD);
    await page.getByPlaceholder('Повторите новый пароль').fill(NEW_PASSWORD);
    await page.keyboard.press('Enter');
    await page.waitForSelector('.shell');
    api = client(env.app, await signIn(env.app, 'admin', NEW_PASSWORD));
    assert.equal((await api.get('/api/auth/me')).body.user.mustChangePassword, false);
  });

  test('session account: check, sync, ad accounts and campaigns drawer', async () => {
    await go('#/accounts');
    await addButton().click();
    await page.waitForSelector('.panel.modal');
    await page.getByRole('tab', { name: 'Сессия (cookies)' }).click();
    await page.locator('.panel.modal .tab-panel:not([hidden]) textarea').first().fill(sessionJson(mock.state.createSession()));
    await submit();
    await page.waitForSelector('.panel.modal', { state: 'detached' });
    const row = page.locator('.accounts-table tbody tr:not(.v-spacer)').first();
    await row.locator('.pill', { hasText: 'Активен' }).waitFor({ timeout: 40_000 });
    await row.locator('[data-act=sync]:not([disabled])').click();
    await waitFor(async () => {
      const a = (await api.get('/api/accounts')).body.items.find((x) => x.method === 'session');
      return a?.lastSyncAt && !a.busy;
    }, { timeout: 40_000, message: 'sync finished' });
    await waitFor(async () => (await row.locator('.c-ads').textContent()).trim().startsWith('4'), { timeout: 20_000, message: 'ad accounts counted' });
    await shot('real-02-accounts-active');

    await go('#/ad-accounts');
    await page.waitForSelector('.ads-table tbody tr:not(.v-spacer)');
    assert.equal(await page.locator('.ads-table tbody tr:not(.v-spacer)').count(), 4);
    const text = await page.locator('.ads-table').textContent();
    assert.match(text, /Shop EU/);
    assert.match(text, /Paused Offer/);
    await shot('real-03-ad-accounts');
    await page.locator('.ads-table .link-btn', { hasText: 'Shop EU' }).click();
    await page.waitForSelector('.campaigns tbody tr:not(.v-spacer)');
    assert.equal(await page.locator('.campaigns tbody tr:not(.v-spacer)').count(), 2);
    assert.match(await page.locator('.campaigns').textContent(), /Недостаточно средств/);
    await shot('real-04-campaigns-drawer');
    await closeLayers();
  });

  test('password login: the code dialog accepts a wrong code, then the right one', async () => {
    await addPasswordAccount('code1@x.test');
    await page.waitForSelector('.panel.modal .code-input', { timeout: 45_000 });
    await shot('real-05-code-dialog');
    await page.locator('.code-input').fill('000000');
    await page.keyboard.press('Enter');
    await page.locator('#toasts .toast', { hasText: 'Код отправлен' }).first().waitFor({ timeout: 10_000 });
    await page.waitForSelector('.panel.modal', { state: 'detached' });
    await waitFor(async () => /не принял/.test((await api.get('/api/accounts?q=code1')).body.items[0]?.statusDetail || ''), { timeout: 40_000, message: 'retry prompt' });
    // After a rejected code the UI may re-open the dialog by itself; otherwise use the row button.
    await page.locator('.panel.modal .code-input, [data-act=code]').first().waitFor({ timeout: 20_000 });
    if (!(await page.locator('.panel.modal .code-input').count())) {
      await rowFor('code1@x.test').locator('[data-act=code]').click();
      await page.waitForSelector('.panel.modal .code-input');
    }
    await page.locator('.code-input').fill('123456');
    await page.keyboard.press('Enter');
    await statusOf('code1@x.test', 'Активен');
    await shot('real-06-after-code');
  });

  test('captcha: the remote browser dialog finishes the login with one click', async () => {
    await addPasswordAccount('captcha1@x.test');
    await rowFor('captcha1@x.test').locator('.pill', { hasText: 'Нужно вмешательство' }).waitFor({ timeout: 45_000 });
    if (await page.locator('.panel.modal').count()) await page.keyboard.press('Escape');
    await rowFor('captcha1@x.test').locator('[data-act=browser]').first().click();
    await page.waitForSelector('.panel.modal .rb-stage');
    await page.waitForFunction(() => document.querySelector('.rb-img')?.naturalWidth > 100, null, { timeout: 15_000 });
    await shot('real-07-remote-browser');
    const id = (await api.get('/api/accounts?q=captcha1')).body.items[0].id;
    const info = (await api.get(`/api/accounts/${id}/browser`)).body;
    const box = await page.locator('.rb-img').boundingBox();
    await page.mouse.click(box.x + (170 / info.width) * box.width, box.y + (360 / info.height) * box.height);
    await statusOf('captcha1@x.test', 'Активен');
    await page.keyboard.press('Escape');
  });

  test('wrong password and bulk import are shown by the UI', async () => {
    await addPasswordAccount('bad1@x.test');
    await statusOf('bad1@x.test', 'Неверный пароль');
    await addButton().click();
    await page.getByRole('tab', { name: 'Массовый импорт' }).click();
    await page.locator('.panel.modal .tab-panel:not([hidden]) textarea').first().fill('imp1@mail.test:pass1\nimp2@mail.test;pass2\nbroken');
    await submit();
    await page.waitForSelector('.import-result');
    assert.match(await page.locator('.import-result').textContent(), /Строка 3/);
    await page.keyboard.press('Escape');
    await rowFor('imp2@mail.test').waitFor();
  });

  test('dashboard, journal and settings render live data', async () => {
    await go('#/dashboard');
    await page.waitForSelector('.shell');
    await page.waitForTimeout(600);
    const dash = await page.locator('main, .view, .content').first().textContent();
    assert.match(dash, /Логины/);
    assert.match(dash, /Рекламные кабинеты/);
    await shot('real-08-dashboard');
    await go('#/journal');
    await page.waitForSelector('table tbody tr:not(.v-spacer)');
    assert.ok((await page.locator('table tbody tr:not(.v-spacer)').count()) >= 5);
    assert.match(await page.locator('table').first().textContent(), /Вход выполнен|login\.success|Код подтверждения/);
    await go('#/settings');
    await page.waitForTimeout(500);
    assert.match(await page.locator('.shell').textContent(), new RegExp(env.ctx.version.replace('.', '\\.')));
    await shot('real-09-settings');
    await go('#/modules');
    await shot('real-10-modules');
  });

  test('no unexpected browser errors', async () => {
    // 401 before sign-in and a 404 screenshot after the browser closes by itself are expected.
    const real = problems.filter((p) => !/\/api\/auth\/me/.test(p) && !/browser\/screenshot/.test(p));
    assert.deepEqual(real, [], `browser problems:\n${real.join('\n')}`);
  });
});
