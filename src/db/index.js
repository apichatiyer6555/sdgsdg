import Database from 'better-sqlite3';

const V1 = `
CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  login TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin',
  must_change_password INTEGER NOT NULL DEFAULT 0,
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  last_login_at TEXT
);

CREATE TABLE panel_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  ip TEXT NOT NULL DEFAULT '',
  user_agent TEXT NOT NULL DEFAULT ''
);
CREATE INDEX panel_sessions_user ON panel_sessions(user_id);

CREATE TABLE accounts (
  id INTEGER PRIMARY KEY,
  label TEXT NOT NULL DEFAULT '',
  login TEXT NOT NULL DEFAULT '',
  method TEXT NOT NULL DEFAULT 'password',
  password_enc TEXT,
  session_enc TEXT,
  session_updated_at TEXT,
  proxy_enc TEXT,
  user_agent TEXT NOT NULL DEFAULT '',
  locale TEXT NOT NULL DEFAULT '',
  timezone TEXT NOT NULL DEFAULT '',
  viewport TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'new',
  status_detail TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]',
  client TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  disabled INTEGER NOT NULL DEFAULT 0,
  ad_accounts_count INTEGER NOT NULL DEFAULT 0,
  bc_count INTEGER NOT NULL DEFAULT 0,
  last_login_at TEXT,
  last_check_at TEXT,
  last_sync_at TEXT,
  last_error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX accounts_status ON accounts(status);

CREATE TABLE business_centers (
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  bc_id TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  account_count INTEGER NOT NULL DEFAULT 0,
  synced_at TEXT NOT NULL,
  PRIMARY KEY (account_id, bc_id)
);

CREATE TABLE ad_accounts (
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  advertiser_id TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  country TEXT NOT NULL DEFAULT '',
  currency TEXT NOT NULL DEFAULT '',
  status INTEGER,
  bc_id TEXT NOT NULL DEFAULT '',
  bc_name TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'unknown',
  campaigns_total INTEGER NOT NULL DEFAULT 0,
  campaigns_loaded INTEGER NOT NULL DEFAULT 0,
  campaigns_working INTEGER NOT NULL DEFAULT 0,
  campaigns_enabled INTEGER NOT NULL DEFAULT 0,
  campaigns_problem INTEGER NOT NULL DEFAULT 0,
  spend REAL NOT NULL DEFAULT 0,
  impressions INTEGER NOT NULL DEFAULT 0,
  clicks INTEGER NOT NULL DEFAULT 0,
  conversions INTEGER NOT NULL DEFAULT 0,
  reasons TEXT NOT NULL DEFAULT '[]',
  needs_top_up INTEGER NOT NULL DEFAULT 0,
  error TEXT NOT NULL DEFAULT '',
  period TEXT NOT NULL DEFAULT '7d',
  period_st TEXT NOT NULL DEFAULT '',
  period_et TEXT NOT NULL DEFAULT '',
  synced_at TEXT,
  PRIMARY KEY (account_id, advertiser_id)
);
CREATE INDEX ad_accounts_state ON ad_accounts(state);
CREATE INDEX ad_accounts_advertiser ON ad_accounts(advertiser_id);

CREATE TABLE campaigns (
  account_id INTEGER NOT NULL,
  advertiser_id TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'off',
  enabled INTEGER,
  reason TEXT NOT NULL DEFAULT '',
  reason_kind TEXT NOT NULL DEFAULT '',
  budget REAL NOT NULL DEFAULT 0,
  spend REAL NOT NULL DEFAULT 0,
  impressions INTEGER NOT NULL DEFAULT 0,
  clicks INTEGER NOT NULL DEFAULT 0,
  conversions INTEGER NOT NULL DEFAULT 0,
  synced_at TEXT NOT NULL,
  PRIMARY KEY (account_id, advertiser_id, campaign_id),
  FOREIGN KEY (account_id, advertiser_id) REFERENCES ad_accounts(account_id, advertiser_id) ON DELETE CASCADE
);

CREATE TABLE ad_account_history (
  account_id INTEGER NOT NULL,
  advertiser_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  period TEXT NOT NULL,
  spend REAL NOT NULL,
  impressions INTEGER NOT NULL,
  clicks INTEGER NOT NULL,
  conversions INTEGER NOT NULL
);
CREATE INDEX ad_account_history_key ON ad_account_history(account_id, advertiser_id, ts);

CREATE TABLE events (
  id INTEGER PRIMARY KEY,
  ts TEXT NOT NULL,
  level TEXT NOT NULL DEFAULT 'info',
  kind TEXT NOT NULL DEFAULT '',
  account_id INTEGER,
  account_label TEXT NOT NULL DEFAULT '',
  user_login TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL DEFAULT ''
);
CREATE INDEX events_account ON events(account_id, id);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

const MIGRATIONS = [V1];

export function openDatabase(file) {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
  const current = db.pragma('user_version', { simple: true });
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
  return db;
}

export const nowIso = () => new Date().toISOString();
