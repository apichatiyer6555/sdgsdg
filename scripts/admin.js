#!/usr/bin/env node
// Admin helper: node scripts/admin.js list | reset <login> [newPassword] | create <login> [password] [role]
import { loadConfig } from '../src/config.js';
import { openDatabase } from '../src/db/index.js';
import { generatePassword } from '../src/lib/crypto.js';
import { UserService } from '../src/services/users.js';

const [cmd, login, password, role] = process.argv.slice(2);
const config = loadConfig();
const db = openDatabase(config.dbFile);
const users = new UserService(db);

try {
  if (cmd === 'list') {
    for (const u of users.list()) console.log(`${u.id}\t${u.login}\t${u.role}\t${u.disabled ? 'disabled' : 'active'}\tlast=${u.lastLoginAt || '-'}`);
  } else if (cmd === 'reset' && login) {
    const row = users.getByLogin(login);
    if (!row) throw new Error(`user "${login}" not found`);
    const next = password || generatePassword(18);
    await users.update(row.id, { password: next, disabled: false });
    db.prepare('DELETE FROM panel_sessions WHERE user_id = ?').run(row.id);
    console.log(`Password for ${login}: ${next}\n(one-time: the panel will ask to change it at the next login)`);
  } else if (cmd === 'create' && login) {
    const next = password || generatePassword(18);
    await users.create({ login, password: next, role: role || 'admin', mustChangePassword: true });
    console.log(`Created ${login} (${role || 'admin'}). Password: ${next}`);
  } else {
    console.log('Usage: node scripts/admin.js list | reset <login> [newPassword] | create <login> [password] [owner|admin|viewer]');
    process.exitCode = 1;
  }
} catch (e) {
  console.error(`Error: ${e.message}`);
  process.exitCode = 1;
} finally {
  db.close();
}
