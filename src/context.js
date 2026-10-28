import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PanelSessions } from './auth/sessions.js';
import { BrowserPool } from './browser/pool.js';
import { Operations } from './browser/operations.js';
import { openDatabase } from './db/index.js';
import { Scheduler } from './jobs/scheduler.js';
import { createVault, generatePassword } from './lib/crypto.js';
import { AccountService } from './services/accounts.js';
import { AdAccountService } from './services/adaccounts.js';
import { EventLog } from './services/events.js';
import { Settings } from './services/settings.js';
import { UserService } from './services/users.js';

export function createContext(config, { log = () => {} } = {}) {
  const db = openDatabase(config.dbFile);
  const vault = createVault(config.appKey);
  const runtime = new Map();
  const events = new EventLog(db);
  const settings = new Settings(db, config);
  const users = new UserService(db);
  const panelSessions = new PanelSessions(db, config);
  const accounts = new AccountService({ db, vault, runtime, config, events });
  const adAccounts = new AdAccountService({ db, accounts });
  const pool = new BrowserPool(config);
  const ops = new Operations({ config, pool, accounts, adAccounts, events, runtime });
  const scheduler = new Scheduler({ config, db, settings, ops, events, panelSessions, log });
  let version = '0.0.0';
  try { version = JSON.parse(readFileSync(path.join(config.root, 'package.json'), 'utf8')).version; } catch { /* keep default */ }
  return { config, db, vault, runtime, events, settings, users, panelSessions, accounts, adAccounts, pool, ops, scheduler, version };
}

// First start: create the owner. Returns the generated password when none was provided.
export async function bootstrapAdmin(ctx) {
  if (ctx.users.count() > 0) return null;
  const provided = ctx.config.admin.password;
  const password = provided || generatePassword(18);
  await ctx.users.create({ login: ctx.config.admin.login, password, role: 'owner', mustChangePassword: true });
  ctx.events.add({ kind: 'bootstrap', message: `Создан владелец ${ctx.config.admin.login}.` });
  return provided ? null : { login: ctx.config.admin.login, password };
}
