import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { chromium } from 'playwright-core';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { bootstrapAdmin, createContext } from '../../src/context.js';

export const PASSWORD = 'Admin-Pass-12345';

export function findChrome() {
  for (const p of [process.env.BROWSER_EXECUTABLE, '/usr/local/bin/google-chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser']) {
    if (p && existsSync(p)) return p;
  }
  try {
    const bundled = chromium.executablePath();
    if (bundled && existsSync(bundled)) return bundled;
  } catch { /* browsers not installed */ }
  return '';
}

export async function makeApp(env = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'zaliv-test-'));
  const config = loadConfig({
    NODE_ENV: 'test', DATA_DIR: dir, BACKUP_DIR: path.join(dir, 'backups'), APP_KEY: randomBytes(32).toString('base64'), ADMIN_PASSWORD: PASSWORD,
    BROWSER_EXECUTABLE: process.env.ZALIV_TEST_CHANNEL ? '' : findChrome(), LOGIN_POLL_MS: '120', LOGIN_TIMEOUT_MS: '8000', PAGE_TIMEOUT_MS: '15000', LOG_LEVEL: 'silent', ...env
  });
  const ctx = createContext(config);
  await bootstrapAdmin(ctx);
  ctx.db.prepare('UPDATE users SET must_change_password = 0').run();
  const app = await buildApp(ctx);
  await app.ready();
  return {
    app, ctx, dir,
    async close() {
      ctx.scheduler.stop();
      await app.close();
      await ctx.ops.shutdown();
      ctx.db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

export async function signIn(app, login = 'admin', password = PASSWORD) {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { login, password } });
  if (res.statusCode !== 200) throw new Error(`login failed: ${res.statusCode} ${res.body}`);
  const cookie = res.headers['set-cookie'].split(';')[0];
  return { cookie, csrf: res.json().csrf, user: res.json().user };
}

// Tiny client around app.inject for tests.
export function client(app, session) {
  const call = async (method, url, payload) => {
    const headers = session ? { cookie: session.cookie, 'x-csrf-token': session.csrf } : {};
    const res = await app.inject({ method, url, headers, payload });
    let body = null;
    try { body = res.json(); } catch { body = res.body; }
    return { status: res.statusCode, body, headers: res.headers, raw: res.rawPayload };
  };
  return {
    get: (u) => call('GET', u),
    post: (u, p) => call('POST', u, p ?? {}),
    patch: (u, p) => call('PATCH', u, p),
    put: (u, p) => call('PUT', u, p),
    del: (u) => call('DELETE', u)
  };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(fn, { timeout = 30_000, step = 150, message = 'condition' } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = await fn();
    if (value) return value;
    await sleep(step);
  }
  throw new Error(`timeout waiting for ${message}`);
}
