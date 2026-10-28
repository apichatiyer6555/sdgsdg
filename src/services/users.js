import { nowIso } from '../db/index.js';
import { hashPassword } from '../lib/crypto.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { oneOf, str, validPassword } from '../lib/validate.js';

export const ROLES = ['owner', 'admin', 'viewer'];

export class UserService {
  constructor(db) {
    this.db = db;
  }

  static dto(row) {
    return {
      id: row.id, login: row.login, role: row.role, mustChangePassword: !!row.must_change_password,
      disabled: !!row.disabled, createdAt: row.created_at, lastLoginAt: row.last_login_at
    };
  }

  count() { return this.db.prepare('SELECT COUNT(*) AS n FROM users').get().n; }
  getById(id) { return this.db.prepare('SELECT * FROM users WHERE id = ?').get(id); }
  getByLogin(login) { return this.db.prepare('SELECT * FROM users WHERE login = ?').get(String(login ?? '')); }
  list() { return this.db.prepare('SELECT * FROM users ORDER BY id').all().map(UserService.dto); }
  touchLogin(id) { this.db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(nowIso(), id); }

  #owners(exceptId) {
    return this.db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'owner' AND disabled = 0 AND id != ?").get(exceptId ?? 0).n;
  }

  async create({ login, password, role = 'admin', mustChangePassword = false }) {
    const name = str(login, { name: 'Логин', min: 3, max: 64, required: true });
    if (!/^[A-Za-z0-9_.@-]+$/.test(name)) throw badRequest('Логин: только латиница, цифры и . _ @ -');
    oneOf(role, ROLES, 'Роль');
    const pass = validPassword(password);
    if (this.getByLogin(name)) throw conflict('Пользователь с таким логином уже есть.');
    const hash = await hashPassword(pass);
    const info = this.db.prepare('INSERT INTO users (login, password_hash, role, must_change_password, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(name, hash, role, mustChangePassword ? 1 : 0, nowIso());
    return this.getById(Number(info.lastInsertRowid));
  }

  async update(id, { role, password, disabled, mustChangePassword }) {
    const row = this.getById(id);
    if (!row) throw notFound('Пользователь не найден.');
    const next = { role: row.role, disabled: row.disabled, hash: row.password_hash, must: row.must_change_password };
    if (role !== undefined) next.role = oneOf(role, ROLES, 'Роль');
    if (disabled !== undefined) next.disabled = disabled ? 1 : 0;
    if (password) { next.hash = await hashPassword(validPassword(password)); next.must = mustChangePassword === false ? 0 : 1; }
    if (mustChangePassword !== undefined && !password) next.must = mustChangePassword ? 1 : 0;
    const losesOwner = row.role === 'owner' && !row.disabled && (next.role !== 'owner' || next.disabled);
    if (losesOwner && this.#owners(id) === 0) throw conflict('Нельзя убрать последнего владельца.');
    this.db.prepare('UPDATE users SET role = ?, disabled = ?, password_hash = ?, must_change_password = ? WHERE id = ?')
      .run(next.role, next.disabled, next.hash, next.must, id);
    return this.getById(id);
  }

  async setPassword(id, password) {
    const hash = await hashPassword(validPassword(password, 'Новый пароль'));
    this.db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(hash, id);
  }

  remove(id) {
    const row = this.getById(id);
    if (!row) throw notFound('Пользователь не найден.');
    if (row.role === 'owner' && !row.disabled && this.#owners(id) === 0) throw conflict('Нельзя удалить последнего владельца.');
    this.db.prepare('DELETE FROM users WHERE id = ?').run(id);
  }
}
