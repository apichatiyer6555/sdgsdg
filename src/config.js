import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const bool = (value, fallback) => {
  if (value === undefined || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(value));
};
const int = (value, fallback, min = -Infinity, max = Infinity) => {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

export function loadConfig(env = process.env) {
  const production = env.NODE_ENV === 'production';
  const origin = String(env.TIKTOK_ADS_ORIGIN || 'https://ads.tiktok.com').replace(/\/+$/, '');
  const dataDir = path.resolve(env.DATA_DIR || path.join(ROOT, 'data'));
  const backupDir = path.resolve(env.BACKUP_DIR || path.join(ROOT, 'backups'));

  let appKey = env.APP_KEY || '';
  if (!appKey) {
    if (production) throw new Error('APP_KEY is required in production (base64, 32 bytes). Generate: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"');
    appKey = randomBytes(32).toString('base64'); // dev/test only: data encrypted with it is lost on restart
  }
  const keyBytes = Buffer.from(appKey, 'base64');
  if (keyBytes.length !== 32) throw new Error('APP_KEY must decode to exactly 32 bytes');

  const config = {
    root: ROOT,
    production,
    host: env.HOST || '0.0.0.0',
    port: int(env.PORT, 3000, 1, 65535),
    dataDir,
    backupDir,
    dbFile: env.DB_FILE ? path.resolve(env.DB_FILE) : path.join(dataDir, 'zaliv.db'),
    webDir: path.join(ROOT, 'web'),
    appKey: keyBytes,
    cookieSecure: bool(env.COOKIE_SECURE, production),
    trustProxy: bool(env.TRUST_PROXY, true),
    sessionTtlHours: int(env.SESSION_TTL_HOURS, 24 * 14, 1, 24 * 90),
    logLevel: env.LOG_LEVEL || (production ? 'info' : 'warn'),
    admin: { login: env.ADMIN_LOGIN || 'admin', password: env.ADMIN_PASSWORD || '' },
    tiktok: {
      origin,
      loginUrl: env.TIKTOK_LOGIN_URL || `${origin}/i18n/login`,
      homeUrl: env.TIKTOK_HOME_URL || `${origin}/i18n/dashboard`,
      maxAdAccountsPerSync: int(env.SYNC_MAX_AD_ACCOUNTS, 100, 1, 2000)
    },
    browser: {
      headless: bool(env.BROWSER_HEADLESS, true),
      executablePath: env.BROWSER_EXECUTABLE || '',
      maxInteractive: int(env.BROWSER_MAX_INTERACTIVE, 6, 1, 30),
      maxBackground: int(env.BROWSER_MAX_BACKGROUND, 3, 1, 12),
      noSandbox: bool(env.BROWSER_NO_SANDBOX, true),
      locale: env.BROWSER_LOCALE || 'en-US',
      timezone: env.BROWSER_TIMEZONE || 'Europe/Kyiv',
      loginTimeoutMs: int(env.LOGIN_TIMEOUT_MS, 90_000, 5_000, 600_000),
      codeWaitMs: int(env.CODE_WAIT_MS, 20 * 60_000, 10_000, 3 * 3600_000),
      manualWaitMs: int(env.MANUAL_WAIT_MS, 30 * 60_000, 10_000, 6 * 3600_000),
      assistIdleMs: int(env.ASSIST_IDLE_MS, 15 * 60_000, 10_000, 3 * 3600_000),
      pageTimeoutMs: int(env.PAGE_TIMEOUT_MS, 45_000, 5_000, 180_000),
      pollMs: int(env.LOGIN_POLL_MS, 700, 50, 5000)
    },
    sync: {
      autoEnabled: bool(env.AUTO_SYNC, false),
      intervalMin: int(env.SYNC_INTERVAL_MIN, 60, 15, 1440),
      tickMs: int(env.SCHEDULER_TICK_MS, 60_000, 500, 600_000),
      batch: int(env.SYNC_BATCH, 10, 1, 100)
    },
    backup: { enabled: bool(env.BACKUP_ENABLED, production), keep: int(env.BACKUP_KEEP, 14, 1, 365) }
  };
  mkdirSync(config.dataDir, { recursive: true });
  return config;
}
