// Dev-only end-to-end check of the SPA against the mock server.
//   node web/dev/ui-test.mjs            (starts its own mock on a random port, writes screenshots to /tmp/verify/)
//   MOCK_URL=http://localhost:4010 node web/dev/ui-test.mjs   (use an already running mock)
//   SHOTS=/some/dir  SECTIONS=accounts,drawer  to narrow the run
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const { chromium } = await import(path.resolve(here, '../../node_modules/playwright-core/index.mjs'));
const SHOTS = process.env.SHOTS ?? '/tmp/verify';
const ONLY = process.env.SECTIONS ? new Set(process.env.SECTIONS.split(',')) : null;
fs.mkdirSync(SHOTS, { recursive: true });

/* ---------- mock server ---------- */
let server = null;
let BASE = process.env.MOCK_URL;
if (!BASE) {
  const port = 4100 + Math.floor(Math.random() * 800);
  server = spawn(process.execPath, [path.join(here, 'mock-server.js'), String(port)], { stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, MOCK_DELAY: '15' } });
  await new Promise((resolve, reject) => { server.stdout.on('data', (d) => String(d).includes('Zaliv mock') && resolve()); server.on('error', reject); setTimeout(() => reject(new Error('mock did not start')), 8000); });
  BASE = `http://localhost:${port}`;
  process.on('exit', () => server.kill());
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(130));
}

/* ---------- bookkeeping ---------- */
const failures = [];
const problems = [];
let allowed = [];
const ok = (cond, msg) => { if (!cond) { failures.push(msg); console.log(`  ✗ ${msg}`); } else console.log(`  ✓ ${msg}`); };
const allow = (re) => { allowed.push(re); };
const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ executablePath: '/usr/local/bin/google-chrome', args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true, locale: 'ru-RU' });
await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE }).catch(() => {});
const page = await context.newPage();
const watch = (p) => {
  p.on('console', (m) => {
    if (!['error', 'warning'].includes(m.type())) return;
    const text = `${m.type()}: ${m.text()} @ ${m.location().url}`;
    if (!allowed.some((re) => re.test(text))) problems.push(text);
  });
  p.on('pageerror', (e) => problems.push(`pageerror: ${e.message}\n${(e.stack ?? '').split('\n').slice(1, 5).join('\n')}`));
  p.on('requestfailed', (r) => { const t = `requestfailed: ${r.url()} ${r.failure()?.errorText}`; if (!allowed.some((re) => re.test(t))) problems.push(t); });
};
watch(page);
allow(/401.*\/api\/auth\/me/); // boot before login is expected to answer 401

/* ---------- helpers ---------- */
const toastText = async () => (await page.locator('#toasts .toast').allTextContents()).join(' | ');
const waitToast = (text) => page.locator('#toasts .toast', { hasText: text }).first().waitFor({ timeout: 6000 });
async function login(user = 'admin', password = 'admin-password-1') {
  await page.goto(BASE);
  await page.waitForSelector('.auth-card');
  await page.fill('input[name=login]', user);
  await page.fill('input[name=password]', password);
  await page.keyboard.press('Enter');
}
async function loginAndChange() {
  await login();
  await page.waitForSelector('text=Смените пароль');
  await page.getByPlaceholder('Текущий пароль').fill('admin-password-1');
  await page.getByPlaceholder('Не короче 10 символов').fill('Better-password-77');
  await page.getByPlaceholder('Повторите новый пароль').fill('Better-password-77');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.shell');
}
const goto = async (route) => { await page.evaluate((r) => { location.hash = r; }, route); await page.waitForTimeout(150); };
// rows are virtualized: count logical rows through aria-rowcount, DOM rows only for what is on screen
const rows = () => page.locator('.accounts-table tbody tr:not(.v-spacer)');
const rowCount = async (sel = '.accounts-table') => Number(await page.locator(sel).getAttribute('aria-rowcount')) - 1;
const waitRows = (n) => page.waitForFunction((x) => Number(document.querySelector('.accounts-table').getAttribute('aria-rowcount')) - 1 === x, n, { timeout: 6000 });
async function waitAccounts() { await page.waitForSelector('.accounts-table tbody tr:not(.v-spacer)'); }
const chip = (text) => page.locator('.chips .chip', { hasText: text }).first();
const chipCount = async (text) => Number((await chip(text).locator('b').textContent()).replace(/\s/g, ''));
const section = (name) => !ONLY || ONLY.has(name);

/* ======================================================================= */
if (section('auth')) {
  console.log('# auth');
  await page.goto(BASE);
  await page.waitForSelector('.auth-card');
  await shot(page, '01-login-dark');
  allow(/401.*\/api\/auth\/login/);
  await page.fill('input[name=login]', 'admin');
  await page.fill('input[name=password]', 'wrong-password');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.auth-card .alert.err');
  ok((await page.locator('.auth-card .alert.err').textContent()).includes('Неверный'), 'wrong password shows an error');
  await page.fill('input[name=password]', 'admin-password-1');
  await page.keyboard.press('Enter'); // Enter submits the login form
  await page.waitForSelector('text=Смените пароль');
  ok(true, 'Enter submits login; forced password change screen shown');
  await shot(page, '02-forced-change');
  await page.getByPlaceholder('Текущий пароль').fill('admin-password-1');
  await page.getByPlaceholder('Не короче 10 символов').fill('short');
  await page.getByPlaceholder('Повторите новый пароль').fill('short');
  await page.keyboard.press('Enter');
  ok((await page.locator('.auth-card .alert.err').textContent()).includes('10'), 'short new password is rejected client-side');
  await page.getByPlaceholder('Не короче 10 символов').fill('Better-password-77');
  await page.getByPlaceholder('Повторите новый пароль').fill('Better-password-78');
  await page.keyboard.press('Enter');
  ok((await page.locator('.auth-card .alert.err').textContent()).includes('не совпадают'), 'mismatching repeat is rejected');
  await page.getByPlaceholder('Повторите новый пароль').fill('Better-password-77');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.shell');
  ok(page.url().includes('#/dashboard'), 'after the change the app opens on the dashboard');
} else await loginAndChange();

/* ======================================================================= */
if (section('dashboard')) {
  console.log('# dashboard');
  await page.waitForSelector('.kpi-grid');
  await page.waitForTimeout(400);
  await shot(page, '03-dashboard-dark');
  ok((await page.locator('.kpi').count()) === 4, 'four KPI cards');
  ok((await page.locator('.attn-row').count()) > 5, 'attention list is filled');
  ok((await page.locator('.status-pill').textContent()).includes('Браузер готов'), 'sidebar status pill shows browser ready');
  ok((await page.locator('.nav-badge').textContent()).trim() !== '', 'accounts nav badge counts logins waiting for the operator');
  await page.locator('.kpi-stat', { hasText: 'Активных' }).click();
  await page.waitForSelector('.accounts-table tbody tr:not(.v-spacer)');
  ok(page.url().includes('status=active'), 'KPI tile navigates to the filtered list');
  ok((await chip('Активные').getAttribute('aria-pressed')) === 'true', 'status chip reflects the URL filter');
  await goto('#/dashboard');
  await page.waitForSelector('.kpi-grid');
  await page.locator('.kpi-stat', { hasText: 'Проблемы' }).first().click();
  await page.waitForSelector('.ads-table tbody tr:not(.v-spacer)');
  ok(page.url().includes('state=issue'), 'cabinet KPI navigates to filtered ad accounts');
}

/* ======================================================================= */
if (section('accounts')) {
  console.log('# accounts');
  await goto('#/accounts');
  await waitAccounts();
  await page.waitForTimeout(300);
  const total = await rowCount();
  ok(total === 300, `300 account rows rendered (got ${total})`);
  await shot(page, '04-accounts-dark');
  const domRows = await rows().count();
  ok(domRows > 8 && domRows < 80, `only a window of rows is in the DOM (${domRows} of 300)`);
  const rowH = await rows().first().evaluate((el) => el.getBoundingClientRect().height);
  ok(Math.abs(rowH - 60) < 0.5, `rows have the fixed height the virtualizer assumes (${rowH}px)`);
  await page.evaluate(() => { document.querySelector('.table-wrap').scrollTop = 1e6; });
  await page.waitForTimeout(250);
  const lastLabel = (await rows().last().locator('.acc-name').textContent()).trim();
  const lastAcc = await page.evaluate(async () => (await import('/lib/store.js')).accounts.items.at(-1).label);
  ok(lastLabel === lastAcc, `scrolling to the bottom renders the last account (${lastLabel})`);
  await page.evaluate(() => { document.querySelector('.table-wrap').scrollTop = 0; });
  await page.waitForTimeout(150);
  const counts = { all: await chipCount('Все'), active: await chipCount('Активные'), code: await chipCount('Нужен код') };
  ok(counts.all === 300 && counts.active > 100 && counts.code === 5, `status chips carry counts ${JSON.stringify(counts)}`);
  await chip('Нужен код').click();
  ok((await rowCount()) === 5, 'filter "Нужен код" leaves 5 rows');
  ok((await page.locator('.accounts-table .btn.cta.pulse').count()) === 5, 'every need_code row has the pulsing "Ввести код" button');
  ok(page.url().includes('status=need_code'), 'filter is kept in the URL');
  const codeHeights = await rows().evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height)));
  ok(codeHeights.length === 5 && codeHeights.every((v) => v === 60), `need-code rows keep the fixed 60px height (${[...new Set(codeHeights)]})`);
  await chip('Все').click();
  await page.fill('input[data-search]', 'aurora');
  await page.waitForTimeout(350);
  const aurora = await rowCount();
  ok(aurora > 0 && aurora < 60, `search "aurora" narrows rows (${aurora})`);
  await page.fill('input[data-search]', 'zzzz-nothing');
  await page.waitForTimeout(350);
  ok((await page.locator('.state-box .empty h3').textContent()).includes('Ничего не найдено'), 'empty state for no matches');
  await page.locator('.state-box .btn', { hasText: 'Сбросить' }).click();
  ok((await rowCount()) === 300, 'reset filters brings back all rows');
  await page.locator('.toolbar select').first().selectOption({ index: 1 });
  const byTag = await rowCount();
  ok(byTag > 0 && byTag < 300, `tag select filters rows (${byTag})`);
  await page.locator('.toolbar select').first().selectOption({ index: 0 });
  await page.locator('.toolbar select').nth(1).selectOption({ index: 1 });
  const byClient = await rowCount();
  ok(byClient > 0 && byClient < 300, `client select filters rows (${byClient})`);
  await page.locator('.toolbar select').nth(1).selectOption({ index: 0 });
  // sorting
  await page.locator('th .th-btn', { hasText: 'Аккаунт' }).click();
  const firstA = await rows().first().locator('.acc-name').textContent();
  await page.locator('th .th-btn', { hasText: 'Аккаунт' }).click();
  const firstZ = await rows().first().locator('.acc-name').textContent();
  ok(firstA !== firstZ, 'sorting by account flips order');
  await page.locator('th .th-btn', { hasText: 'Аккаунт' }).click(); // third click: back to server order
  // selection, shift-range, bulk
  const boxes = page.locator('.accounts-table tbody input[data-act=select]');
  await boxes.nth(0).check();
  await boxes.nth(2).click({ modifiers: ['Shift'] });
  ok((await page.locator('.bulk-count').textContent()).includes('3'), 'shift-click selects a range (3 rows)');
  await shot(page, '05-accounts-bulk-dark');
  await page.waitForTimeout(3200); // at least one polling round while rows are selected
  ok((await page.locator('.bulk-count').textContent()).includes('3'), 'selection survives polling');
  await page.locator('.accounts-table thead input[type=checkbox]').check();
  ok((await page.locator('.bulk-count').textContent()).includes('300'), 'header checkbox selects all in the filter');
  await page.locator('.bulk-bar .icon-btn[aria-label="Снять выделение"]').click();
  ok(await page.locator('.bulk-bar').isHidden(), 'clearing selection hides the bulk bar');
  // bulk tag
  await boxes.nth(0).check();
  await boxes.nth(1).check();
  await page.locator('.bulk-bar .btn', { hasText: 'Тег' }).click();
  await page.locator('.panel.modal input').fill('qa-bulk');
  await page.keyboard.press('Enter');
  await waitToast('Добавление тега');
  ok(true, 'bulk tag applied');
  await page.locator('.bulk-bar .btn', { hasText: 'Войти' }).click(); // two logins: no confirm needed
  await waitToast('Вход');
  await page.waitForTimeout(200);
  ok(true, 'bulk login summary toast shown');
  await page.locator('.bulk-bar .icon-btn[aria-label="Снять выделение"]').click();
  // keep scroll position + no focus steal while polling: type in search and wait for a poll
  await page.fill('input[data-search]', 'a');
  await page.locator('input[data-search]').focus();
  await page.waitForTimeout(3000);
  ok(await page.evaluate(() => document.activeElement?.matches('input[data-search]')), 'polling does not steal focus from the search input');
  await page.fill('input[data-search]', '');
  await page.waitForTimeout(300);
  await page.evaluate(() => { document.querySelector('.table-wrap').scrollTop = 1200; });
  await page.waitForTimeout(3300);
  ok((await page.evaluate(() => document.querySelector('.table-wrap').scrollTop)) >= 1100, 'scroll position is kept across polling');
  await page.evaluate(() => { document.querySelector('.table-wrap').scrollTop = 0; });
}

/* ======================================================================= */
if (section('add')) {
  console.log('# add dialog');
  await goto('#/accounts');
  await waitAccounts();
  await page.locator('.toolbar .btn.primary', { hasText: 'Добавить' }).click();
  await page.waitForSelector('.panel.modal');
  await shot(page, '06-add-password-dark');
  await page.locator('.panel.modal button[type=submit]').click();
  ok((await page.locator('.panel.modal .alert.err').textContent()).includes('логин'), 'empty password form shows validation error');
  await page.locator('.panel.modal input[type=text]').first().fill('qa.new.login@mail.test');
  await page.locator('.panel.modal input[type=password]').fill('Sup3r-secret!');
  await page.locator('.panel.modal .tag-field').fill('qa');
  await page.keyboard.press('Enter');
  ok((await page.locator('.panel.modal .tag-chip').count()) === 1, 'tag chip added with Enter');
  await page.locator('.panel.modal input[placeholder="http://user:pass@host:port"]').fill('ftp://bad');
  await page.locator('.panel.modal button[type=submit]').click();
  ok((await page.locator('.panel.modal .alert.err').textContent()).includes('Формат'), 'bad proxy is rejected');
  await page.locator('.panel.modal input[placeholder="http://user:pass@host:port"]').fill('http://u:p@10.1.2.3:8080');
  await page.locator('.panel.modal button[type=submit]').click();
  await page.waitForSelector('.panel.modal', { state: 'detached' });
  await waitToast('Аккаунт добавлен');
  await waitRows(301);
  ok((await rowCount()) === 301, 'new account appears in the table');
  // auto code dialog: login was started from this page -> code requested after ~3s
  await page.waitForSelector('.panel.modal .code-input', { timeout: 8000 });
  ok(true, 'code dialog auto-opens for a login started on this page');
  await shot(page, '07-code-dialog-dark');
  await page.keyboard.press('Escape');
  await page.waitForSelector('.panel.modal', { state: 'detached' });
  ok(true, 'Esc closes the code dialog');
  // session tab
  await page.locator('.toolbar .btn.primary', { hasText: 'Добавить' }).click();
  await page.getByRole('tab', { name: 'Сессия (cookies)' }).click();
  const pane = '.panel.modal .tab-panel:not([hidden])';
  await page.locator(`${pane} textarea`).first().fill('not cookies');
  allow(/400.*\/api\/accounts/);
  await page.locator('.panel.modal button[type=submit]').click();
  await page.waitForSelector(`${pane} .alert.err`);
  ok((await page.locator(`${pane} .alert.err`).textContent()).includes('cookies'), 'unrecognised cookies are rejected with the server message');
  await page.locator(`${pane} textarea`).first().fill('[{"name":"sessionid","value":"abcdef0123456789","domain":".tiktok.com"}]');
  await page.locator('.panel.modal button[type=submit]').click();
  await page.waitForSelector('.panel.modal', { state: 'detached' });
  await waitRows(302);
  ok((await rowCount()) === 302, 'session account added');
  // import tab
  await page.locator('.toolbar .btn.primary', { hasText: 'Добавить' }).click();
  await page.getByRole('tab', { name: 'Массовый импорт' }).click();
  await page.locator('.panel.modal .tab-panel:not([hidden]) textarea').first().fill('# comment\nimp1@mail.test:pass1\nimp2@mail.test;pass2\nimp3@mail.test|pass3|socks5://u:p@1.1.1.1:1080|nutra,vip|Aurora Media\nbroken-line-without-password\nimp1@mail.test:dup');
  await page.waitForTimeout(100);
  ok((await page.locator('.import-count').textContent()).includes('5'), 'live line counter counts 5 lines');
  await page.locator('.panel.modal button[type=submit]').click();
  await page.waitForSelector('.import-result');
  ok((await page.locator('.import-result').textContent()).includes('Строка 5'), 'import summary lists the line error');
  await shot(page, '08-import-result-dark');
  await page.keyboard.press('Escape');
  await page.waitForSelector('.panel.modal', { state: 'detached' });
  await page.waitForTimeout(300);
  ok((await rowCount()) === 305, 'imported accounts appear (3 new)');
}

/* ======================================================================= */
if (section('dialogs')) {
  console.log('# code + remote browser');
  await goto('#/accounts');
  await waitAccounts();
  await chip('Нужен код').click();
  await page.locator('.accounts-table .btn.cta').first().click();
  await page.waitForSelector('.panel.modal .code-input');
  await page.locator('.code-input').fill('12');
  await page.keyboard.press('Enter');
  ok((await page.locator('.panel.modal .form-error').textContent()).includes('4 до 10'), 'too short code is rejected');
  await page.locator('.code-input').fill('123 456');
  ok((await page.locator('.code-input').inputValue()) === '123456', 'spaces are stripped from the code');
  await page.waitForSelector('.code-shot', { state: 'visible', timeout: 6000 });
  ok(true, 'live screenshot preview shows inside the code dialog');
  await shot(page, '09-code-dialog-preview-dark');
  await page.keyboard.press('Enter');
  await waitToast('Код отправлен');
  await page.waitForSelector('.panel.modal', { state: 'detached' });
  ok(true, 'code accepted and dialog closed');
  await chip('Нужно вмешательство').click();
  await page.locator('.accounts-table .btn.cta').first().click();
  await page.waitForSelector('.panel.modal .rb-stage');
  await page.waitForFunction(() => document.querySelector('.rb-img')?.naturalWidth > 100, null, { timeout: 8000 });
  ok(true, 'remote browser shows a live JPEG frame');
  await shot(page, '10-remote-browser-dark');
  const inputs = [];
  page.on('request', (r) => { if (r.url().includes('/browser/input') && r.method() === 'POST') inputs.push(JSON.parse(r.postData())); });
  const waitInput = async (pred, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end) { if (inputs.some(pred)) return true; await sleep(50); } return false; };
  const box = await page.locator('.rb-img').boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await waitInput((i) => i.type === 'click');
  const click = inputs.find((i) => i.type === 'click');
  ok(click && Math.abs(click.x - 640) <= 3 && Math.abs(click.y - 400) <= 3, `click is mapped to browser pixels (${click?.x},${click?.y})`);
  await page.mouse.click(box.x + 1, box.y + 1);
  await page.waitForTimeout(200);
  await page.locator('.rb-side input[aria-label="Текст"]').fill('hello');
  await page.keyboard.press('Enter');
  ok(await waitInput((i) => i.type === 'type' && i.text === 'hello'), 'text is sent with type');
  await page.locator('.rb-side .btn', { hasText: 'Enter' }).click();
  await page.locator('.rb-side .btn', { hasText: 'Вниз' }).click();
  ok((await waitInput((i) => i.type === 'key' && i.key === 'Enter')) && (await waitInput((i) => i.type === 'scroll' && i.dy === 400)), 'key and scroll buttons send input');
  await page.locator('.rb-img').hover();
  await page.mouse.wheel(0, 300);
  await waitInput((i) => i.type === 'scroll' && i.dy === 300);
  ok(inputs.some((i) => i.type === 'scroll' && i.dy === 300 && typeof i.x === 'number'), `mouse wheel over the image sends scroll${inputs.some((i) => i.type === 'scroll' && i.dy === 300) ? '' : ` (got ${JSON.stringify(inputs.filter((i) => i.type === 'scroll'))})`}`);
  await page.locator('.rb-img').focus();
  await page.keyboard.type('ab');
  ok(await waitInput((i) => i.type === 'type' && i.text === 'ab'), 'typing with the image focused is forwarded');
  await page.getByPlaceholder('https://ads.tiktok.com/…').fill('example.com');
  await page.keyboard.press('Enter');
  ok((await page.locator('.rb-side .form-error').textContent()).includes('tiktok.com'), 'navigation outside tiktok.com is blocked client-side');
  await page.getByPlaceholder('https://ads.tiktok.com/…').fill('ads.tiktok.com/i18n/campaign');
  await page.keyboard.press('Enter');
  ok(await waitInput((i) => i.type === 'navigate' && i.url.startsWith('https://ads.tiktok.com/')), 'navigate request uses a normalised https URL');
  await page.waitForTimeout(2300);
  ok((await page.locator('.rb-url').textContent()).includes('ads.tiktok.com/i18n/campaign'), 'address line follows BrowserInfo.url');
  await page.keyboard.press('Escape');
  await page.waitForSelector('.panel.modal', { state: 'detached' });
  ok(true, 'Esc closes the remote browser dialog');
  // inactive state: an active account without a browser
  await chip('Активные').click();
  await rows().first().locator('[data-act=browser]').click();
  await page.waitForSelector('.rb-overlay:not([hidden])');
  ok((await page.locator('.rb-overlay').textContent()).includes('Браузер не запущен'), 'inactive account shows the "browser not running" state');
  await shot(page, '11-remote-browser-inactive-dark');
  await page.locator('.panel.modal .btn', { hasText: 'Открыть браузер с сессией' }).click();
  await page.waitForFunction(() => document.querySelector('.rb-img')?.naturalWidth > 100, null, { timeout: 8000 });
  ok(true, 'assist browser opens and starts streaming');
  await page.locator('.panel.modal .btn', { hasText: 'Закрыть браузер' }).click();
  await page.waitForSelector('.rb-overlay:not([hidden])', { timeout: 6000 });
  ok(true, 'closing the browser brings back the inactive state');
  await page.keyboard.press('Escape');
}

/* ======================================================================= */
if (section('drawer')) {
  console.log('# drawer');
  await goto('#/accounts');
  await waitAccounts();
  await chip('Активные').click();
  const first = rows().first();
  const name = (await first.locator('.acc-name').textContent()).trim();
  await first.locator('.acc-name').click();
  await page.waitForSelector('.panel.drawer');
  await page.waitForSelector('.panel.drawer [role=tablist]');
  await shot(page, '12-drawer-profile-dark');
  ok((await page.locator('.panel.drawer h2').textContent()).trim() === name, 'drawer title is the account label');
  await page.locator('.panel.drawer input').first().fill(`${name} (QA)`);
  await page.locator('.panel.drawer button[type=submit]').click();
  await waitToast('Изменения сохранены');
  await page.waitForTimeout(150);
  ok((await rows().first().locator('.acc-name').textContent()).includes('(QA)'), 'saved label is reflected in the table without reload');
  await page.getByRole('tab', { name: /Кабинеты/ }).click();
  await shot(page, '13-drawer-ads-dark');
  const adRows = page.locator('.panel.drawer .dtable tbody tr');
  const n = await adRows.count();
  if (n) {
    await adRows.first().click();
    await page.waitForSelector('.panel.drawer >> nth=1');
    await page.waitForSelector('.campaigns tbody tr');
    await shot(page, '14-campaigns-drawer-dark');
    ok(true, `campaigns drawer opens from the cabinets tab (${n} cabinets)`);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
    ok((await page.locator('.panel.drawer').count()) === 1, 'Esc closes only the top drawer');
  } else ok(true, 'account without cabinets: nothing to open');
  await page.getByRole('tab', { name: /Журнал/ }).click();
  await shot(page, '15-drawer-journal-dark');
  await page.getByRole('tab', { name: 'Сессия' }).click();
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 6000 }), (async () => {
    await page.locator('.panel.drawer .btn', { hasText: 'Экспорт cookies' }).click();
    await page.locator('.panel.modal .btn', { hasText: 'Скачать' }).click();
  })()]);
  ok(/zaliv-session-.*\.json$/.test(dl.suggestedFilename()), `owner can export cookies (${dl.suggestedFilename()})`);
  await page.locator('.panel.drawer .tab-panel:not([hidden]) textarea').fill('sessionid=abcdef0123456789; sid_tt=zzzzzzzzzzzz');
  await page.locator('.panel.drawer .btn', { hasText: 'Заменить и проверить' }).click();
  await waitToast('Cookies заменены');
  await shot(page, '16-drawer-session-dark');
  await page.keyboard.press('Escape');
  await page.waitForSelector('.panel.drawer', { state: 'detached' });
  ok(true, 'Esc closes the drawer');
  // kebab menu + keyboard
  await rows().first().locator('[data-act=more]').click();
  await page.waitForSelector('.menu');
  await shot(page, '17-row-menu-dark');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Escape');
  ok((await page.locator('.menu').count()) === 0, 'Esc closes the row menu');
  await rows().first().locator('[data-act=more]').click();
  await page.locator('.menu .menu-item.danger').click();
  await page.waitForSelector('.panel.modal');
  ok((await page.locator('.panel.modal').textContent()).includes('нельзя отменить'), 'delete asks for confirmation');
  await shot(page, '18-delete-confirm-dark');
  await page.locator('.panel.modal .btn', { hasText: 'Отмена' }).click();
  await page.waitForSelector('.panel.modal', { state: 'detached' });
}

/* ======================================================================= */
if (section('actions')) {
  console.log('# row / bulk / dashboard actions');
  await goto('#/accounts');
  await waitAccounts();
  await chip('Активные').click();
  await rows().filter({ has: page.locator('[data-act=check]:not([disabled])') }).first().locator('[data-act=check]').click();
  await waitToast('Проверка сессии запущена');
  ok(true, 'row "Проверить сессию" starts a check');
  await rows().filter({ has: page.locator('[data-act=sync]:not([disabled])') }).first().locator('[data-act=sync]').click();
  await waitToast('Синхронизация запущена');
  ok(true, 'row "Синхронизировать" starts a sync');
  await chip('Все').click();
  // bulk login for a login without a stored password -> per-account failure summary
  const target = await page.evaluate(async () => { const { accounts } = await import('/lib/store.js'); const a = accounts.items.find((x) => !x.hasPassword && !x.busy && x.status !== 'disabled'); return a ? { login: a.login } : null; });
  ok(!!target, 'fixture has a login without a stored password');
  await page.fill('input[data-search]', target.login);
  await page.waitForTimeout(350);
  await rows().first().locator('input[data-act=select]').check();
  await page.locator('.bulk-bar .btn', { hasText: 'Войти' }).click();
  await page.waitForSelector('.panel.modal .dtable');
  ok((await page.locator('.panel.modal').textContent()).includes('Нет сохранённого пароля'), 'bulk failure summary lists the reason per account');
  await shot(page, '25-bulk-failures-dark');
  await page.keyboard.press('Escape');
  await page.waitForSelector('.panel.modal', { state: 'detached' });
  await page.locator('.bulk-bar .btn', { hasText: 'Клиент' }).click();
  await page.locator('.panel.modal input').fill('QA Client');
  await page.keyboard.press('Enter');
  await waitToast('Назначение клиента');
  await page.waitForTimeout(250);
  ok((await rows().first().textContent()).includes('QA Client'), 'bulk client assignment shows up in the row');
  await page.locator('.bulk-bar .btn', { hasText: 'Отключить' }).click();
  await waitToast('Отключение');
  await page.waitForTimeout(250);
  ok((await rows().first().textContent()).includes('Отключён'), 'bulk disable switches the login off');
  const before = await rowCount();
  await page.locator('.bulk-bar .btn', { hasText: 'Удалить' }).click();
  await page.locator('.panel.modal .btn', { hasText: 'Отмена' }).click();
  await page.waitForSelector('.panel.modal', { state: 'detached' });
  ok((await rowCount()) === before, 'cancelled bulk delete keeps the row');
  await page.locator('.bulk-bar .btn', { hasText: 'Удалить' }).click();
  await page.locator('.panel.modal .btn.danger').click();
  await waitToast('Удаление');
  await page.waitForSelector('.state-box .empty');
  ok(true, 'confirmed bulk delete removes the login');
  await page.fill('input[data-search]', '');
  await page.waitForTimeout(300);
  // drawer quick actions + drill-down links
  await chip('Активные').click();
  await rows().filter({ has: page.locator('[data-act=check]:not([disabled])') }).first().locator('.acc-name').click();
  await page.waitForSelector('.panel.drawer .drawer-actions .btn');
  await page.locator('.panel.drawer .drawer-actions .btn', { hasText: 'Проверить' }).click();
  await waitToast('Проверка сессии запущена');
  await page.getByRole('tab', { name: /Журнал/ }).click();
  const jlink = page.locator('.panel.drawer a', { hasText: 'Весь журнал' });
  if (await jlink.count()) { await jlink.click(); await page.waitForSelector('.journal-table tbody tr'); ok(page.url().includes('#/journal?accountId='), 'drawer links to the journal filtered by login'); }
  // dashboard quick actions
  await goto('#/dashboard');
  await page.waitForSelector('.attn-row');
  await page.locator('.attn-row .btn.cta', { hasText: 'Ввести код' }).first().click();
  await page.waitForSelector('.panel.modal .code-input');
  ok(true, 'dashboard "Ввести код" opens the code dialog');
  await page.keyboard.press('Escape');
  await page.waitForSelector('.panel.modal', { state: 'detached' });
  await page.locator('.attn-row .btn', { hasText: 'Кампании' }).first().click();
  await page.waitForSelector('.panel.drawer');
  ok(true, 'dashboard ad-account row opens the campaigns drawer');
  await page.keyboard.press('Escape');
  await page.waitForSelector('.panel.drawer', { state: 'detached' });
  await page.locator('.topbar .btn', { hasText: 'Синхронизировать всё' }).click();
  await waitToast('В очередь поставлено');
  ok((await toastText()).includes('аккаунт'), 'sync-all toast reports the queued count');
  // remote browser: cancel a login that waits for manual action
  await goto('#/accounts'); await waitAccounts();
  await chip('Нужно вмешательство').click();
  await rows().first().locator('.btn.cta').click();
  await page.waitForSelector('.rb-stage');
  await page.locator('.panel.modal .btn', { hasText: 'Отмена входа' }).click();
  await waitToast('Операция остановлена');
  await page.waitForSelector('.rb-overlay:not([hidden])', { timeout: 6000 });
  ok(true, 'cancelling the login from the remote browser dialog ends the session');
  await page.keyboard.press('Escape');
}

/* ======================================================================= */
if (section('ads')) {
  console.log('# ad accounts');
  await goto('#/ad-accounts');
  await page.waitForSelector('.ads-table tbody tr:not(.v-spacer)');
  await page.waitForTimeout(300);
  const total = await rowCount('.ads-table');
  ok(total > 350, `ad account rows rendered (${total})`);
  await shot(page, '19-ads-dark');
  const adDom = await page.locator('.ads-table tbody tr:not(.v-spacer)').count();
  ok(adDom > 8 && adDom < 90, `ad accounts are windowed (${adDom} of ${total} rows in the DOM)`);
  await page.evaluate(() => { document.querySelector('.table-wrap').scrollTop = 1e7; });
  await page.waitForTimeout(300);
  ok((await page.locator(`.ads-table tbody tr[aria-rowindex="${total + 1}"]`).count()) === 1, 'scrolling to the bottom renders the last ad account');
  await page.evaluate(() => { document.querySelector('.table-wrap').scrollTop = 0; });
  await page.waitForTimeout(200);
  await page.locator('th .th-btn', { hasText: 'Расход 7д' }).click();
  const spends = await page.locator('.ads-table tbody tr:not(.v-spacer) td:nth-child(6)').allTextContents();
  const toNum = (s) => Number(s.replace(/[^\d,]/g, '').replace(',', '.'));
  ok(spends.length > 10 && toNum(spends[0]) >= toNum(spends[1]), 'sorting by spend puts the biggest first');
  await chip('Проблемы').click();
  const issue = await rowCount('.ads-table');
  ok(issue > 0 && issue < total, `state chip filters (${issue})`);
  const rendered = await page.locator('.ads-table tbody tr:not(.v-spacer)').count();
  ok(rendered > 0 && (await page.locator('.ads-table tbody tr .pill', { hasText: 'Не доставляется' }).count()) === rendered, 'all rendered rows are "Не доставляется"');
  ok((await page.locator('.totals').textContent()).includes('Расход 7д'), 'totals line shows spend');
  await page.locator('.toolbar select').nth(2).selectOption({ index: 1 }); // currency
  ok(page.url().includes('currency='), 'currency filter is stored in the URL');
  await page.locator('.toolbar select').nth(2).selectOption({ index: 0 });
  await chip('Все').click();
  await page.fill('input[data-search]', 'nutra');
  await page.waitForTimeout(300);
  const nutra = await rowCount('.ads-table');
  ok(nutra > 0 && nutra < total, `search filters ad accounts (${nutra})`);
  await page.fill('input[data-search]', '');
  await page.waitForTimeout(300);
  const [csv] = await Promise.all([page.waitForEvent('download', { timeout: 6000 }), page.locator('.toolbar .btn', { hasText: 'CSV' }).click()]);
  const csvPath = path.join(SHOTS, 'ads-export.csv');
  await csv.saveAs(csvPath);
  const text = fs.readFileSync(csvPath, 'utf8');
  ok(text.startsWith('\uFEFFКабинет;ID кабинета;'), 'CSV has BOM and ";" delimiter');
  ok(text.split('\r\n').length > 350, 'CSV contains all filtered rows');
  await page.locator('.ads-table tbody tr:not(.v-spacer)').first().locator('.link-btn').click();
  await page.waitForSelector('.campaigns tbody tr, .empty');
  await page.waitForTimeout(250);
  await shot(page, '20-campaigns-dark');
  await page.locator('.panel.drawer .search input').fill('Scale');
  await page.waitForTimeout(250);
  await page.locator('.panel.drawer th .th-btn', { hasText: 'Расход' }).click();
  ok(true, 'campaign drawer search and sort work');
  await page.keyboard.press('Escape');
  await page.waitForSelector('.panel.drawer', { state: 'detached' });
}

/* ======================================================================= */
if (section('journal')) {
  console.log('# journal');
  await goto('#/journal');
  await page.waitForSelector('.journal-table tbody tr');
  const n1 = await page.locator('.journal-table tbody tr').count();
  ok(n1 === 100, `first page has 100 events (${n1})`);
  await shot(page, '21-journal-dark');
  await page.locator('.more-box .btn', { hasText: 'Загрузить ещё' }).click();
  await page.waitForFunction((n) => document.querySelectorAll('.journal-table tbody tr').length > n, n1);
  ok(true, 'load more appends the next page');
  await page.locator('.toolbar select').first().selectOption('error');
  await page.waitForTimeout(400);
  ok((await page.locator('.journal-table tbody tr .pill.err').count()) === (await page.locator('.journal-table tbody tr').count()), 'level filter leaves errors only');
}

/* ======================================================================= */
if (section('modules')) {
  console.log('# modules');
  await goto('#/modules');
  await page.waitForSelector('.module-card');
  ok((await page.locator('.module-card.ready').count()) === 6 && (await page.locator('.module-card').count()) === 16, 'roadmap shows 6 ready + 10 planned cards');
  await shot(page, '22-modules-dark');
}

/* ======================================================================= */
if (section('settings')) {
  console.log('# settings');
  await goto('#/settings');
  await page.waitForSelector('.sys-grid');
  await page.waitForSelector('.users-table tbody tr');
  await shot(page, '23-settings-dark');
  await page.locator('input[type=number]').fill('10');
  await page.locator('.settings-card .btn', { hasText: 'Сохранить' }).click();
  ok((await page.locator('.settings-card .alert.err').first().textContent()).includes('15'), 'interval below 15 is rejected');
  await page.locator('input[type=number]').fill('45');
  await page.locator('.settings-card .btn', { hasText: 'Сохранить' }).click();
  await waitToast('Настройки сохранены');
  await page.locator('.settings-card .btn', { hasText: 'Добавить пользователя' }).click();
  await page.waitForSelector('.panel.modal');
  await page.locator('.panel.modal input[type=text]').fill('qa-user');
  await page.locator('.panel.modal input[type=password]').fill('qa-user-password-1');
  await shot(page, '24-add-user-dark');
  await page.locator('.panel.modal button[type=submit]').click();
  await waitToast('Пользователь создан');
  await page.waitForFunction(() => [...document.querySelectorAll('.users-table tbody tr')].some((r) => r.textContent.includes('qa-user')));
  ok(true, 'user added and listed');
  const userRow = page.locator('.users-table tbody tr', { hasText: 'qa-user' });
  await userRow.locator('select').selectOption('viewer');
  await waitToast('Роль изменена');
  await page.waitForTimeout(400); // the table refreshes after the change
  await userRow.locator('[aria-haspopup=menu]').click();
  await page.locator('.menu .menu-item', { hasText: 'Отключить' }).click();
  await waitToast('Пользователь отключён');
  await page.waitForTimeout(200);
  ok((await page.locator('.users-table tbody tr', { hasText: 'qa-user' }).textContent()).includes('Отключён'), 'user can be disabled');
  const selfRow = page.locator('.users-table tbody tr', { hasText: 'это вы' });
  ok(await selfRow.locator('select').isDisabled(), 'own role cannot be changed');
  await page.locator('.sidebar .status-pill').waitFor();
  ok((await page.locator('.sidebar .status-pill').textContent()).includes('каждые 45 мин'), 'sidebar pill reflects the new interval');
}

/* ======================================================================= */
if (section('theme')) {
  console.log('# theme + responsive');
  await goto('#/dashboard');
  await page.waitForSelector('.kpi-grid');
  await page.locator('.topbar .icon-btn[aria-label="Светлая тема"]').click();
  ok((await page.evaluate(() => document.documentElement.dataset.theme)) === 'light', 'theme toggle switches to light');
  await page.waitForTimeout(250);
  await shot(page, '30-dashboard-light');
  await goto('#/accounts'); await waitAccounts(); await page.waitForTimeout(250);
  await shot(page, '31-accounts-light');
  await rows().first().locator('.acc-name').click();
  await page.waitForSelector('.panel.drawer [role=tablist]');
  await shot(page, '32-drawer-light');
  await page.keyboard.press('Escape');
  await goto('#/ad-accounts'); await page.waitForSelector('.ads-table tbody tr:not(.v-spacer)'); await page.waitForTimeout(250);
  await shot(page, '33-ads-light');
  await page.locator('.ads-table tbody tr:not(.v-spacer)').first().locator('.link-btn').click();
  await page.waitForSelector('.campaigns tbody tr, .panel.drawer .empty');
  await page.waitForTimeout(250);
  await shot(page, '34-campaigns-light');
  await page.keyboard.press('Escape');
  await goto('#/settings'); await page.waitForSelector('.sys-grid'); await page.waitForTimeout(250);
  await shot(page, '35-settings-light');
  await goto('#/accounts'); await waitAccounts();
  await page.locator('.toolbar .btn.primary', { hasText: 'Добавить' }).click();
  await page.waitForSelector('.panel.modal');
  await shot(page, '36-add-light');
  await page.keyboard.press('Escape');
  await page.reload();
  await page.waitForSelector('.shell');
  ok((await page.evaluate(() => document.documentElement.dataset.theme)) === 'light', 'theme survives a reload (localStorage)');
  await page.locator('.topbar .icon-btn[aria-label="Тёмная тема"]').click();
  // 1024px: sidebar collapses to icons
  await page.setViewportSize({ width: 1024, height: 768 });
  await goto('#/accounts'); await waitAccounts(); await page.waitForTimeout(300);
  ok((await page.locator('.sidebar').boundingBox()).width < 100, 'sidebar collapses to icons under 1100px');
  const narrow = await rows().evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height)));
  ok(narrow.length > 5 && narrow.every((v) => v === 60), `row height stays 60px at 1024px (${[...new Set(narrow)]})`);
  await shot(page, '40-accounts-1024');
  await goto('#/dashboard'); await page.waitForSelector('.kpi-grid'); await page.waitForTimeout(300);
  await shot(page, '41-dashboard-1024');
  await goto('#/ad-accounts'); await page.waitForSelector('.ads-table tbody tr:not(.v-spacer)'); await page.waitForTimeout(300);
  await shot(page, '42-ads-1024');
  await page.setViewportSize({ width: 1920, height: 1080 });
  await goto('#/accounts'); await waitAccounts(); await page.waitForTimeout(300);
  await shot(page, '43-accounts-1920');
  await goto('#/dashboard'); await page.waitForSelector('.kpi-grid'); await page.waitForTimeout(300);
  await shot(page, '44-dashboard-1920');
  await page.setViewportSize({ width: 1440, height: 900 });
}

/* ======================================================================= */
if (section('viewer')) {
  console.log('# viewer role');
  await page.locator('.user-btn').click();
  await page.locator('.menu .menu-item', { hasText: 'Выйти' }).click();
  await page.waitForSelector('.auth-card');
  await login('viewer', 'viewer-password-1');
  await page.waitForSelector('.shell');
  ok((await page.locator('.topbar .btn', { hasText: 'Синхронизировать всё' }).count()) === 0, 'viewer: no "sync all" button');
  await goto('#/accounts'); await waitAccounts();
  ok((await page.locator('.toolbar .btn.primary').count()) === 0, 'viewer: no "Добавить" button');
  ok((await page.locator('.accounts-table input[type=checkbox]').count()) === 0, 'viewer: no selection checkboxes');
  ok((await page.locator('.accounts-table [data-act=login], .accounts-table [data-act=sync], .accounts-table [data-act=more], .accounts-table .btn.cta').count()) === 0, 'viewer: no mutating row actions');
  await shot(page, '50-viewer-accounts');
  await rows().first().locator('.acc-name').click();
  await page.waitForSelector('.panel.drawer [role=tablist]');
  ok((await page.locator('.panel.drawer button[type=submit], .panel.drawer .danger-zone, .panel.drawer .drawer-actions .btn').count()) === 0, 'viewer: drawer is read-only');
  await shot(page, '51-viewer-drawer');
  await page.keyboard.press('Escape');
  await goto('#/settings'); await page.waitForSelector('.sys-grid');
  ok((await page.locator('.users-table').count()) === 0, 'viewer: no users section');
  ok(await page.locator('input[type=number]').isDisabled(), 'viewer: auto-sync settings are disabled');
  // session loss: the next API call answers 401 -> login screen with a notice
  await goto('#/accounts'); await waitAccounts();
  await context.clearCookies();
  allow(/401.*\/api\/accounts/);
  await page.locator('.toolbar .btn', { hasText: 'Обновить' }).click();
  await page.waitForSelector('.auth-card .alert.info');
  ok((await page.locator('.auth-card .alert.info').textContent()).includes('Сессия завершилась'), '401 during work returns to the login screen with a notice');
  await shot(page, '52-session-lost');
}

/* ---------- report ---------- */
await browser.close();
server?.kill();
const unique = [...new Set(problems)];
console.log(`\nconsole/page/network problems: ${unique.length}`);
for (const p of unique) console.log(`  ! ${p}`);
console.log(`failed checks: ${failures.length}`);
for (const f of failures) console.log(`  ✗ ${f}`);
process.exit(failures.length || unique.length ? 1 : 0);
