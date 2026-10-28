import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { nowIso } from '../db/index.js';
import { HttpError } from '../lib/errors.js';

const DAY = 86_400_000;

export class Scheduler {
  constructor({ config, db, settings, ops, events, panelSessions, log = () => {} }) {
    Object.assign(this, { config, db, settings, ops, events, panelSessions, log });
    this.timer = null;
    this.lastRunAt = null;
    this.nextRunAt = null;
    this.lastHousekeeping = 0;
    this.lastBackup = this.#newestBackupTime();
    this.ticking = false;
  }

  // A restart must not trigger another backup (and push old daily copies out of the rotation).
  #newestBackupTime() {
    try {
      const names = readdirSync(this.config.backupDir).filter((f) => /^zaliv-\d{12}\.db$/.test(f));
      return names.reduce((max, f) => Math.max(max, statSync(path.join(this.config.backupDir, f)).mtimeMs), 0);
    } catch { return 0; }
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick().catch((e) => this.log(`scheduler tick failed: ${e.message}`)), this.config.sync.tickMs);
    this.timer.unref();
    setTimeout(() => this.tick().catch(() => {}), 5000).unref();
  }

  stop() { clearInterval(this.timer); this.timer = null; }

  snapshot() {
    const s = this.settings.all();
    return { enabled: s.autoSyncEnabled, intervalMin: s.syncIntervalMin, lastRunAt: this.lastRunAt, nextRunAt: s.autoSyncEnabled ? this.nextRunAt : null, queued: this.ops.pool.background.queued };
  }

  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.#autoSync();
      await this.#housekeeping();
    } finally {
      this.ticking = false;
    }
  }

  async #autoSync() {
    const { autoSyncEnabled, syncIntervalMin } = this.settings.all();
    if (!autoSyncEnabled) return;
    const cutoff = new Date(Date.now() - syncIntervalMin * 60_000).toISOString();
    const due = this.db.prepare(`SELECT id FROM accounts WHERE disabled = 0 AND session_enc IS NOT NULL AND status IN ('active','error')
      AND (last_sync_at IS NULL OR last_sync_at < ?) ORDER BY COALESCE(last_sync_at, '') ASC LIMIT ?`).all(cutoff, this.config.sync.batch);
    const room = Math.max(0, this.ops.pool.background.max * 2 - this.ops.pool.background.active - this.ops.pool.background.queued);
    let started = 0;
    for (const { id } of due.slice(0, room)) {
      try { this.ops.startSync(id, 'auto'); started++; } catch (e) { if (!(e instanceof HttpError)) throw e; }
    }
    if (started) this.lastRunAt = nowIso();
    const next = this.db.prepare("SELECT MIN(last_sync_at) AS t FROM accounts WHERE disabled = 0 AND session_enc IS NOT NULL AND status IN ('active','error') AND last_sync_at IS NOT NULL").get().t;
    this.nextRunAt = new Date(Math.max(Date.now() + this.config.sync.tickMs, next ? Date.parse(next) + syncIntervalMin * 60_000 : 0)).toISOString();
  }

  async #housekeeping() {
    if (Date.now() - this.lastHousekeeping > 3600_000) {
      this.lastHousekeeping = Date.now();
      this.panelSessions.cleanup();
      this.events.prune();
    }
    if (this.config.backup.enabled && Date.now() - this.lastBackup > DAY) {
      this.lastBackup = Date.now();
      await this.backup();
    }
  }

  async backup() {
    mkdirSync(this.config.backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
    const file = path.join(this.config.backupDir, `zaliv-${stamp}.db`);
    await this.db.backup(file);
    const files = readdirSync(this.config.backupDir).filter((f) => /^zaliv-\d{12}\.db$/.test(f)).sort();
    for (const old of files.slice(0, Math.max(0, files.length - this.config.backup.keep))) rmSync(path.join(this.config.backupDir, old), { force: true });
    this.events.add({ kind: 'backup', message: `Резервная копия базы: ${path.basename(file)}.` });
    return file;
  }
}
