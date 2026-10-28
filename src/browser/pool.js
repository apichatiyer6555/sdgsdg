import { chromium } from 'playwright-core';
import { toPlaywrightProxy } from '../lib/proxy.js';
import { toPlaywrightState } from '../lib/cookies.js';

export class Semaphore {
  constructor(max) { this.max = max; this.active = 0; this.waiters = []; }
  get queued() { return this.waiters.length; }
  async acquire() {
    if (this.active < this.max) { this.active++; return; }
    await new Promise((resolve) => this.waiters.push(resolve));
  }
  tryAcquire() {
    if (this.active >= this.max) return false;
    this.active++;
    return true;
  }
  release() {
    const next = this.waiters.shift();
    if (next) next(); else this.active = Math.max(0, this.active - 1);
  }
}

const PLATFORM_SCRIPT = `
try { if (!window.chrome) window.chrome = { runtime: {} }; } catch (e) {}
`;

export class BrowserPool {
  constructor(config) {
    this.config = config;
    this.browser = null;
    this.launching = null;
    this.version = '';
    this.interactive = new Semaphore(config.browser.maxInteractive);
    this.background = new Semaphore(config.browser.maxBackground);
    this.contexts = new Set();
  }

  get ready() { return !!this.browser?.isConnected(); }

  async #launch() {
    const { browser: b } = this.config;
    const args = ['--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled', '--no-first-run', '--no-default-browser-check', '--lang=en-US'];
    if (b.noSandbox) args.push('--no-sandbox');
    const options = { headless: b.headless, args, proxy: { server: 'per-context' } };
    if (b.executablePath) options.executablePath = b.executablePath;
    else if (b.headless) options.channel = 'chromium'; // full Chromium in new headless mode, not the old headless shell
    const browser = await chromium.launch(options);
    browser.on('disconnected', () => { if (this.browser === browser) this.browser = null; });
    this.version = browser.version();
    return browser;
  }

  async getBrowser() {
    if (this.ready) return this.browser;
    this.launching ??= this.#launch().then((br) => { this.browser = br; return br; }).finally(() => { this.launching = null; });
    return this.launching;
  }

  // Chrome UA without the "Headless" token (TikTok never finishes loading pages for HeadlessChrome).
  async userAgent(custom = '') {
    if (custom) return custom;
    await this.getBrowser();
    const major = String(this.version).split('.')[0] || '130';
    return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
  }

  /**
   * profile: { storageState, proxyUrl, userAgent, locale, timezone, viewport: 'WxH' }
   */
  async newContext(profile = {}) {
    const browser = await this.getBrowser();
    const [w, h] = String(profile.viewport || '1366x768').split('x').map(Number);
    const context = await browser.newContext({
      storageState: profile.storageState ? toPlaywrightState(profile.storageState) : undefined,
      proxy: toPlaywrightProxy(profile.proxyUrl),
      userAgent: await this.userAgent(profile.userAgent),
      locale: profile.locale || this.config.browser.locale,
      timezoneId: profile.timezone || this.config.browser.timezone,
      viewport: { width: w > 300 ? w : 1366, height: h > 300 ? h : 768 },
      acceptDownloads: false
    });
    await context.addInitScript(PLATFORM_SCRIPT);
    context.setDefaultTimeout(this.config.browser.pageTimeoutMs);
    this.contexts.add(context);
    context.on('close', () => this.contexts.delete(context));
    return context;
  }

  async close() {
    for (const ctx of [...this.contexts]) await ctx.close().catch(() => {});
    if (this.browser) await this.browser.close().catch(() => {});
    this.browser = null;
  }
}
