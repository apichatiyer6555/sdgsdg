import { HttpError, badRequest, forbidden } from '../lib/errors.js';
import { bool, intId, oneOf } from '../lib/validate.js';
import { ROLES, UserService } from '../services/users.js';

const ATTENTION = {
  need_code: ['need_code', 'Нужен код из почты — введите его в карточке аккаунта.', 0],
  need_manual: ['need_manual', 'Нужно вмешательство: капча или неизвестный шаг входа. Откройте удалённый браузер.', 1],
  bad_credentials: ['bad_credentials', 'Неверный логин или пароль.', 2],
  session_expired: ['session_expired', 'Сессия истекла — войдите заново или вставьте новые cookies.', 3],
  error: ['error', '', 4]
};

export function miscRoutes(app, ctx) {
  const { config, accounts, adAccounts, events, ops, users, panelSessions, settings, scheduler, db } = ctx;
  const startedAt = Date.now();
  const actor = (req) => req.panel.user.login;
  const ownerOnly = (req) => { if (req.panel.user.role !== 'owner') throw forbidden('Раздел доступен только владельцу.'); };
  const writer = (req) => { if (req.panel.user.role === 'viewer') throw forbidden(); };

  app.get('/healthz', async () => ({ ok: true }));

  app.get('/api/dashboard', async () => {
    const list = accounts.list().items;
    const byStatus = {};
    for (const a of list) byStatus[a.status] = (byStatus[a.status] || 0) + 1;
    const accountAttention = list
      .filter((a) => ATTENTION[a.status] && !a.busy)
      .sort((a, b) => ATTENTION[a.status][2] - ATTENTION[b.status][2])
      .map((a) => ({ kind: 'account', accountId: a.id, adAccountId: null, title: a.label, state: a.status, text: a.statusDetail || ATTENTION[a.status][1] || 'Ошибка — см. журнал.' }));
    const ads = adAccounts.summary();
    const { attention: adAttention, ...adRest } = ads;
    const sync = scheduler.snapshot();
    return {
      accounts: { total: list.length, byStatus },
      adAccounts: adRest.adAccounts,
      campaigns: adRest.campaigns,
      spend: { '7d': adRest.spend7d },
      attention: [...accountAttention, ...adAttention.map(({ accountLabel, needsTopUp, ...rest }) => ({ ...rest, text: `${rest.text} · ${accountLabel}` }))].slice(0, 50),
      recentEvents: events.recent(15),
      sync: { autoEnabled: sync.enabled, intervalMin: sync.intervalMin, running: ops.stats().running, queued: sync.queued, lastRunAt: sync.lastRunAt, nextRunAt: sync.nextRunAt }
    };
  });

  app.get('/api/ad-accounts', async (req) => adAccounts.list(req.query || {}));
  app.get('/api/ad-accounts/:accountId/:advertiserId/campaigns', async (req) =>
    adAccounts.campaigns(intId(req.params.accountId, 'Аккаунт'), String(req.params.advertiserId)));

  app.get('/api/journal', async (req) => events.list(req.query || {}));

  app.get('/api/settings', async () => settings.all());
  app.put('/api/settings', async (req) => {
    writer(req);
    const next = settings.update(req.body || {});
    if (!next) throw badRequest('Интервал синхронизации: от 15 до 1440 минут.');
    events.add({ kind: 'settings', user: actor(req), message: `Автосинхронизация: ${next.autoSyncEnabled ? 'включена' : 'выключена'}, интервал ${next.syncIntervalMin} мин.` });
    return next;
  });

  app.get('/api/users', async (req) => { ownerOnly(req); return { items: users.list() }; });
  app.post('/api/users', async (req, reply) => {
    ownerOnly(req);
    const row = await users.create({ login: req.body?.login, password: req.body?.password, role: req.body?.role || 'admin', mustChangePassword: true });
    events.add({ kind: 'user.create', user: actor(req), message: `Создан пользователь ${row.login} (${row.role}).` });
    return reply.code(201).send(UserService.dto(row));
  });
  app.patch('/api/users/:id', async (req) => {
    ownerOnly(req);
    const userId = intId(req.params.id, 'Пользователь');
    const body = req.body || {};
    const patch = {};
    if (body.role !== undefined) patch.role = oneOf(body.role, ROLES, 'Роль');
    if (body.disabled !== undefined) patch.disabled = bool(body.disabled);
    if (body.password) patch.password = body.password;
    if (userId === req.panel.user.id && (patch.disabled || (patch.role && patch.role !== 'owner'))) throw badRequest('Нельзя отключить себя или снять с себя роль владельца.');
    const row = await users.update(userId, patch);
    if (patch.password || patch.disabled) panelSessions.destroyForUser(userId);
    events.add({ kind: 'user.update', user: actor(req), message: `Изменён пользователь ${row.login}.` });
    return UserService.dto(row);
  });
  app.delete('/api/users/:id', async (req, reply) => {
    ownerOnly(req);
    const userId = intId(req.params.id, 'Пользователь');
    if (userId === req.panel.user.id) throw badRequest('Нельзя удалить самого себя.');
    users.remove(userId);
    events.add({ kind: 'user.delete', user: actor(req), message: `Удалён пользователь №${userId}.` });
    return reply.code(204).send();
  });

  app.get('/api/system', async () => {
    const stats = ops.stats();
    const sync = scheduler.snapshot();
    const one = (sql) => db.prepare(sql).get().n;
    return {
      version: ctx.version, uptimeSec: Math.round((Date.now() - startedAt) / 1000), node: process.version, tiktokOrigin: config.tiktok.origin,
      browser: stats.browser,
      scheduler: { enabled: sync.enabled, intervalMin: sync.intervalMin, lastRunAt: sync.lastRunAt, nextRunAt: sync.nextRunAt, running: stats.running },
      counts: { accounts: one('SELECT COUNT(*) AS n FROM accounts'), adAccounts: one('SELECT COUNT(*) AS n FROM ad_accounts'), campaigns: one('SELECT COUNT(*) AS n FROM campaigns') }
    };
  });

  app.post('/api/system/sync-all', async (req, reply) => {
    writer(req);
    const rows = db.prepare("SELECT id FROM accounts WHERE disabled = 0 AND session_enc IS NOT NULL AND status IN ('active','error')").all();
    let queued = 0;
    for (const { id } of rows) { try { ops.startSync(id, actor(req)); queued++; } catch (e) { if (!(e instanceof HttpError)) throw e; } }
    events.add({ kind: 'sync.all', user: actor(req), message: `Запущена синхронизация всех активных аккаунтов: ${queued}.` });
    return reply.code(202).send({ queued });
  });
}
