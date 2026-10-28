import { nowIso } from '../db/index.js';
import { randomToken, sha256 } from '../lib/crypto.js';

export const COOKIE_NAME = 'zaliv_sid';

export class PanelSessions {
  constructor(db, config) {
    this.db = db;
    this.ttlMs = config.sessionTtlHours * 3600_000;
  }

  create(userId, { ip = '', userAgent = '' } = {}) {
    const token = randomToken(32);
    const csrf = randomToken(24);
    const now = Date.now();
    this.db.prepare('INSERT INTO panel_sessions (token_hash, user_id, csrf, created_at, expires_at, last_seen_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(sha256(token), userId, csrf, new Date(now).toISOString(), new Date(now + this.ttlMs).toISOString(), new Date(now).toISOString(), ip.slice(0, 64), userAgent.slice(0, 200));
    return { token, csrf, expiresAt: new Date(now + this.ttlMs) };
  }

  lookup(token) {
    if (!token) return null;
    const hash = sha256(token);
    const row = this.db.prepare(`SELECT s.*, u.login, u.role, u.disabled, u.must_change_password, u.id AS uid, u.created_at AS u_created, u.last_login_at
      FROM panel_sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`).get(hash);
    if (!row) return null;
    if (Date.parse(row.expires_at) < Date.now() || row.disabled) { this.destroy(token); return null; }
    // Slide the expiry at most once an hour to avoid a write per request.
    if (Date.now() - Date.parse(row.last_seen_at) > 3600_000) {
      this.db.prepare('UPDATE panel_sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?')
        .run(nowIso(), new Date(Date.now() + this.ttlMs).toISOString(), hash);
    }
    return {
      csrf: row.csrf,
      tokenHash: hash,
      user: { id: row.uid, login: row.login, role: row.role, mustChangePassword: !!row.must_change_password, disabled: !!row.disabled, createdAt: row.u_created, lastLoginAt: row.last_login_at }
    };
  }

  destroy(token) { this.db.prepare('DELETE FROM panel_sessions WHERE token_hash = ?').run(sha256(token)); }

  destroyForUser(userId, exceptHash = '') {
    this.db.prepare('DELETE FROM panel_sessions WHERE user_id = ? AND token_hash != ?').run(userId, exceptHash);
  }

  cleanup() { this.db.prepare('DELETE FROM panel_sessions WHERE expires_at < ?').run(nowIso()); }
}
