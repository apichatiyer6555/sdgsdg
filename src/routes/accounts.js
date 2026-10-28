import { HttpError, badRequest, forbidden } from '../lib/errors.js';
import { bool, intId, oneOf, str, tags as parseTags } from '../lib/validate.js';

const BULK_ACTIONS = ['login', 'check', 'sync', 'delete', 'tag', 'set_client', 'set_proxy', 'disable', 'enable'];

export function accountRoutes(app, ctx) {
  const { accounts, adAccounts, events, ops } = ctx;
  const actor = (req) => req.panel.user.login;
  const id = (req) => intId(req.params.id, 'Аккаунт');
  // The remote browser shows live logged-in TikTok pages: read-only users must not watch it.
  const noViewer = (req) => { if (req.panel.user.role === 'viewer') throw forbidden('Удалённый браузер недоступен для роли «наблюдатель».'); };

  app.get('/api/accounts', async (req) => {
    const { q, status, tag, client } = req.query || {};
    return accounts.list({ q, status, tag, client });
  });

  app.post('/api/accounts', async (req, reply) => {
    const { row, warnings } = accounts.create(req.body || {}, actor(req));
    if (bool(req.body?.autoStart)) {
      try { if (row.method === 'session') ops.startCheck(row.id, actor(req)); else ops.startLogin(row.id, actor(req)); } catch { /* shown in status */ }
    }
    return reply.code(201).send({ ...accounts.dto(row), warnings });
  });

  app.post('/api/accounts/import', async (req) => {
    const body = req.body || {};
    const defaults = { tags: body.tags, client: str(body.client, { max: 120 }), proxy: str(body.proxy, { max: 300 }) };
    const result = accounts.importLines(body.text, defaults, actor(req));
    if (bool(body.autoStart)) {
      for (const accountId of result.ids) { try { ops.startLogin(accountId, actor(req)); } catch { /* slot limit: operator starts the rest manually */ } }
    }
    events.add({ kind: 'account.import', user: actor(req), message: `Импорт: добавлено ${result.created}, пропущено ${result.skipped}, ошибок ${result.errors.length}.` });
    return { created: result.created, skipped: result.skipped, errors: result.errors };
  });

  app.post('/api/accounts/bulk', async (req) => {
    const body = req.body || {};
    const action = oneOf(String(body.action || ''), BULK_ACTIONS, 'Действие');
    if (!Array.isArray(body.ids) || !body.ids.length || body.ids.length > 1000) throw badRequest('Выберите от 1 до 1000 аккаунтов.');
    const ids = [...new Set(body.ids.map((x) => intId(x, 'Аккаунт')))];
    const value = str(body.value, { max: 300 });
    const ok = [];
    const failed = [];
    for (const accountId of ids) {
      try {
        switch (action) {
          case 'login': ops.startLogin(accountId, actor(req)); break;
          case 'check': ops.startCheck(accountId, actor(req)); break;
          case 'sync': ops.startSync(accountId, actor(req)); break;
          case 'delete': await ops.release(accountId); accounts.remove(accountId, actor(req)); break;
          case 'tag': {
            if (!value) throw badRequest('Укажите тег.');
            const row = accounts.requireRow(accountId);
            accounts.update(accountId, { tags: [...parseTags(row.tags ? JSON.parse(row.tags) : []), ...parseTags(value)] }, actor(req));
            break;
          }
          case 'set_client': accounts.update(accountId, { client: value }, actor(req)); break;
          case 'set_proxy': accounts.update(accountId, { proxy: value }, actor(req)); break;
          case 'disable': await ops.release(accountId); accounts.update(accountId, { disabled: true }, actor(req)); break;
          case 'enable': accounts.update(accountId, { disabled: false }, actor(req)); break;
          default: break;
        }
        ok.push(accountId);
      } catch (e) {
        failed.push({ id: accountId, error: e instanceof HttpError ? e.message : String(e.message).slice(0, 200) });
      }
    }
    return { ok, failed };
  });

  app.get('/api/accounts/:id', async (req) => {
    const accountId = id(req);
    return {
      account: accounts.get(accountId),
      adAccounts: adAccounts.forAccount(accountId),
      events: events.list({ accountId, limit: 50 }).items
    };
  });

  app.patch('/api/accounts/:id', async (req) => {
    const accountId = id(req);
    const row = accounts.update(accountId, req.body || {}, actor(req));
    return accounts.dto(row);
  });

  app.delete('/api/accounts/:id', async (req, reply) => {
    const accountId = id(req);
    accounts.requireRow(accountId);
    await ops.release(accountId);
    accounts.remove(accountId, actor(req));
    return reply.code(204).send();
  });

  app.post('/api/accounts/:id/session', async (req) => {
    const accountId = id(req);
    if (ops.isBusy(accountId)) throw new HttpError(409, 'Сначала дождитесь завершения текущей операции.', 'busy');
    const parsed = accounts.replaceSession(accountId, req.body?.session, actor(req));
    if (bool(req.body?.check)) { try { ops.startCheck(accountId, actor(req)); } catch { /* status stays "new" */ } }
    return { ...accounts.get(accountId), warnings: parsed.warnings };
  });

  app.get('/api/accounts/:id/session/export', async (req) => {
    if (req.panel.user.role !== 'owner') throw forbidden('Экспорт сессии доступен только владельцу.');
    const accountId = id(req);
    const state = accounts.loadSession(accountId);
    if (!state?.cookies?.length) throw new HttpError(404, 'У аккаунта нет сохранённой сессии.', 'not_found');
    events.add({ level: 'warn', kind: 'session.export', accountId, accountLabel: accounts.getRow(accountId).label, user: actor(req), message: 'Выгружены cookies сессии.' });
    return state;
  });

  app.post('/api/accounts/:id/login', async (req, reply) => reply.code(202).send(ops.startLogin(id(req), actor(req))));
  app.post('/api/accounts/:id/code', async (req) => ops.submitCode(id(req), req.body?.code, actor(req)));
  app.post('/api/accounts/:id/cancel', async (req) => ops.cancel(id(req), actor(req)));
  app.post('/api/accounts/:id/check', async (req, reply) => reply.code(202).send(ops.startCheck(id(req), actor(req))));
  app.post('/api/accounts/:id/sync', async (req, reply) => reply.code(202).send(ops.startSync(id(req), actor(req))));

  // ---- remote browser ----
  app.get('/api/accounts/:id/browser', async (req) => { noViewer(req); return ops.browserInfo(id(req)); });
  app.get('/api/accounts/:id/browser/screenshot', async (req, reply) => {
    noViewer(req);
    const image = await ops.screenshot(id(req));
    return reply.header('content-type', 'image/jpeg').header('cache-control', 'no-store').send(image);
  });
  app.post('/api/accounts/:id/browser/input', async (req, reply) => {
    await ops.input(id(req), req.body || {});
    return reply.code(204).send();
  });
  app.post('/api/accounts/:id/browser/open', async (req) => ops.openAssist(id(req), str(req.body?.url, { max: 500 }), actor(req)));
  app.post('/api/accounts/:id/browser/close', async (req, reply) => {
    const accountId = id(req);
    await ops.closeAssist(accountId, actor(req));
    return reply.code(204).send();
  });
}
