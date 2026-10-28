import { COOKIE_NAME } from '../auth/sessions.js';
import { generatePassword, hashPassword, verifyPassword } from '../lib/crypto.js';
import { HttpError, badRequest } from '../lib/errors.js';
import { createLimiter } from '../lib/ratelimit.js';
import { str, validPassword } from '../lib/validate.js';
import { UserService } from '../services/users.js';

// Verified against when the login does not exist, so response time does not reveal valid logins.
const DUMMY_HASH = await hashPassword(generatePassword(24));

export function authRoutes(app, ctx) {
  const { config, users, panelSessions, events } = ctx;
  const perLogin = createLimiter({ max: 8, windowMs: 10 * 60_000 });
  const perIp = createLimiter({ max: 40, windowMs: 10 * 60_000 });
  app.addHook('onClose', async () => { perLogin.stop(); perIp.stop(); });

  const cookieOptions = () => ({ httpOnly: true, sameSite: 'lax', secure: config.cookieSecure, path: '/', maxAge: config.sessionTtlHours * 3600 });

  app.post('/api/auth/login', async (req, reply) => {
    const login = str(req.body?.login, { name: 'Логин', required: true, max: 120 });
    const password = str(req.body?.password, { name: 'Пароль', required: true, max: 300, trim: false });
    const loginKey = `${req.ip}|${login.toLowerCase()}`;
    const ipKey = req.ip;
    for (const [limiter, key] of [[perLogin, loginKey], [perIp, ipKey]]) {
      const state = limiter.check(key);
      if (!state.allowed) {
        reply.header('retry-after', state.retryAfterSec);
        throw new HttpError(429, `Слишком много попыток входа. Повторите через ${Math.ceil(state.retryAfterSec / 60)} мин.`, 'rate_limited');
      }
    }
    const row = users.getByLogin(login);
    const ok = await verifyPassword(password, row?.password_hash || DUMMY_HASH);
    if (!row || row.disabled || !ok) {
      perLogin.fail(loginKey);
      perIp.fail(ipKey);
      events.add({ level: 'warn', kind: 'auth.failed', user: login.slice(0, 80), message: `Неудачная попытка входа с ${req.ip}.` });
      throw new HttpError(401, 'Неверный логин или пароль.', 'invalid_credentials');
    }
    perLogin.reset(loginKey);
    const { token, csrf } = panelSessions.create(row.id, { ip: req.ip, userAgent: String(req.headers['user-agent'] || '') });
    users.touchLogin(row.id);
    events.add({ kind: 'auth.login', user: row.login, message: `Вход в панель с ${req.ip}.` });
    reply.setCookie(COOKIE_NAME, token, cookieOptions());
    return { user: UserService.dto(users.getById(row.id)), csrf };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    panelSessions.destroy(req.cookies[COOKIE_NAME]);
    reply.clearCookie(COOKIE_NAME, { path: '/' });
    return reply.code(204).send();
  });

  app.get('/api/auth/me', async (req) => ({ user: req.panel.user, csrf: req.panel.csrf }));

  app.post('/api/auth/change-password', async (req, reply) => {
    const current = str(req.body?.currentPassword, { name: 'Текущий пароль', required: true, max: 300, trim: false });
    const next = validPassword(req.body?.newPassword, 'Новый пароль');
    const row = users.getById(req.panel.user.id);
    if (!(await verifyPassword(current, row.password_hash))) throw new HttpError(400, 'Текущий пароль указан неверно.', 'invalid_credentials');
    if (current === next) throw badRequest('Новый пароль должен отличаться от текущего.');
    await users.setPassword(row.id, next);
    panelSessions.destroyForUser(row.id, req.panel.tokenHash);
    events.add({ kind: 'auth.password', user: row.login, message: 'Пароль изменён.' });
    return reply.code(204).send();
  });
}

