import { nowIso } from '../db/index.js';

const MAX_EVENTS = 20_000;

export class EventLog {
  constructor(db) {
    this.db = db;
    this.insert = db.prepare('INSERT INTO events (ts, level, kind, account_id, account_label, user_login, message) VALUES (?, ?, ?, ?, ?, ?, ?)');
  }

  add({ level = 'info', kind = '', accountId = null, accountLabel = '', user = '', message = '' }) {
    const info = this.insert.run(nowIso(), level, String(kind).slice(0, 60), accountId, String(accountLabel).slice(0, 160), String(user).slice(0, 80), String(message).slice(0, 600));
    return Number(info.lastInsertRowid);
  }

  static dto(row) {
    return { id: row.id, ts: row.ts, level: row.level, kind: row.kind, accountId: row.account_id, accountLabel: row.account_label, user: row.user_login, message: row.message };
  }

  list({ accountId, level, limit = 100, before } = {}) {
    const where = [];
    const args = [];
    if (accountId) { where.push('account_id = ?'); args.push(Number(accountId)); }
    if (level) { where.push('level = ?'); args.push(level); }
    if (before) { where.push('id < ?'); args.push(Number(before)); }
    const cap = Math.min(Math.max(Number(limit) || 100, 1), 500);
    const rows = this.db.prepare(`SELECT * FROM events ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`).all(...args, cap + 1);
    return { items: rows.slice(0, cap).map(EventLog.dto), hasMore: rows.length > cap };
  }

  recent(n = 15) { return this.list({ limit: n }).items; }

  prune() {
    this.db.prepare('DELETE FROM events WHERE id <= (SELECT COALESCE(MAX(id), 0) - ? FROM events)').run(MAX_EVENTS);
    this.db.prepare("DELETE FROM ad_account_history WHERE ts < datetime('now', '-120 days')").run();
  }
}
