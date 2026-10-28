export class Settings {
  constructor(db, config) {
    this.db = db;
    this.defaults = { autoSyncEnabled: config.sync.autoEnabled, syncIntervalMin: config.sync.intervalMin };
    this.get_ = db.prepare('SELECT value FROM settings WHERE key = ?');
    this.set_ = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  }

  raw(key) {
    const row = this.get_.get(key);
    if (!row) return undefined;
    try { return JSON.parse(row.value); } catch { return undefined; }
  }

  put(key, value) { this.set_.run(key, JSON.stringify(value)); }

  all() {
    return {
      autoSyncEnabled: this.raw('autoSyncEnabled') ?? this.defaults.autoSyncEnabled,
      syncIntervalMin: this.raw('syncIntervalMin') ?? this.defaults.syncIntervalMin
    };
  }

  update(patch) {
    if (typeof patch.autoSyncEnabled === 'boolean') this.put('autoSyncEnabled', patch.autoSyncEnabled);
    if (patch.syncIntervalMin !== undefined) {
      const n = Number(patch.syncIntervalMin);
      if (!Number.isFinite(n) || n < 15 || n > 1440) return null;
      this.put('syncIntervalMin', Math.round(n));
    }
    return this.all();
  }
}
