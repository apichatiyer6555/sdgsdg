import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { COOKIE_NAME } from './auth/sessions.js';
import { HttpError, forbidden } from './lib/errors.js';
import { safeEqual } from './lib/crypto.js';
import { accountRoutes } from './routes/accounts.js';
import { authRoutes } from './routes/auth.js';
import { miscRoutes } from './routes/misc.js';

const PUBLIC_API = new Set(['POST /api/auth/login']);
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

export async function buildApp(ctx) {
  const { config } = ctx;
  const app = Fastify({
    trustProxy: config.trustProxy,
    disableRequestLogging: (req) => req.url === '/healthz',
    bodyLimit: 2 * 1024 * 1024,
    logger: {
      level: config.logLevel,
      redact: ['req.headers.cookie', 'req.headers["x-csrf-token"]', 'req.headers.authorization']
    }
  });

  await app.register(cookie);
  app.decorateRequest('panel', null);

  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('content-security-policy', CSP);
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'same-origin');
    if (req.raw.url.startsWith('/api/')) reply.header('cache-control', 'no-store');
    else if (!reply.getHeader('cache-control')) reply.header('cache-control', 'no-cache');
    return payload;
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.message, code: err.code });
    if (err.validation || err.statusCode === 400 || err.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') {
      return reply.code(400).send({ error: 'Некорректный запрос.', code: 'validation' });
    }
    if (err.statusCode === 413) return reply.code(413).send({ error: 'Слишком большой запрос.', code: 'too_large' });
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: 'Внутренняя ошибка сервера.', code: 'internal' });
  });

  app.setNotFoundHandler((req, reply) => {
    if (req.raw.url.startsWith('/api/')) return reply.code(404).send({ error: 'Не найдено.', code: 'not_found' });
    return reply.code(404).type('text/plain').send('Not found');
  });

  app.addHook('onRequest', async (req) => {
    const url = req.raw.url.split('?')[0];
    if (!url.startsWith('/api/')) return;
    if (PUBLIC_API.has(`${req.method} ${url}`)) return;
    const found = ctx.panelSessions.lookup(req.cookies?.[COOKIE_NAME]);
    if (!found) throw new HttpError(401, 'Требуется вход.', 'unauthorized');
    req.panel = found;
    const unsafe = !SAFE_METHODS.has(req.method);
    if (unsafe) {
      if (!safeEqual(req.headers['x-csrf-token'], found.csrf)) throw forbidden('Сессия устарела: обновите страницу.', 'csrf');
      const origin = req.headers.origin;
      if (origin) {
        let host = '';
        try { host = new URL(origin).host; } catch { /* handled below */ }
        const expected = String(req.headers['x-forwarded-host'] || req.headers.host || '');
        if (host !== expected) throw forbidden('Запрос с чужого origin отклонён.', 'csrf');
      }
    }
    const isAuth = url.startsWith('/api/auth/');
    if (found.user.mustChangePassword && !isAuth) throw forbidden('Сначала смените пароль.', 'must_change_password');
    if (unsafe && found.user.role === 'viewer' && !isAuth) throw forbidden('Роль «наблюдатель» не позволяет изменять данные.');
  });

  authRoutes(app, ctx);
  accountRoutes(app, ctx);
  miscRoutes(app, ctx);

  await app.register(fastifyStatic, {
    root: config.webDir,
    index: ['index.html'],
    cacheControl: false
  });

  return app;
}
