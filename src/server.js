import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { bootstrapAdmin, createContext } from './context.js';

const config = loadConfig();
const ctx = createContext(config, { log: (msg) => console.error(`[zaliv] ${msg}`) });

const generated = await bootstrapAdmin(ctx);
if (generated) {
  console.log('='.repeat(64));
  console.log(`[zaliv] Создан владелец панели. Логин: ${generated.login}  Пароль: ${generated.password}`);
  console.log('[zaliv] Пароль одноразовый: при первом входе панель потребует его сменить.');
  console.log('='.repeat(64));
}
const recovered = ctx.ops.recoverStatuses();
if (recovered) console.log(`[zaliv] Сброшены статусы прерванных операций: ${recovered}`);

const app = await buildApp(ctx);
ctx.scheduler.start();
ctx.pool.getBrowser().then((b) => console.log(`[zaliv] Chromium ${b.version()} готов`)).catch((e) => console.error(`[zaliv] Chromium не запустился: ${e.message.split('\n')[0]}`));
await app.listen({ host: config.host, port: config.port });
console.log(`[zaliv] v${ctx.version} слушает ${config.host}:${config.port}, TikTok: ${config.tiktok.origin}, браузер: ${config.browser.headless ? 'headless' : 'headful'}`);

let closing = false;
async function shutdown(signal) {
  if (closing) return;
  closing = true;
  console.log(`[zaliv] ${signal}: останавливаюсь…`);
  const force = setTimeout(() => process.exit(1), 15_000);
  force.unref();
  try {
    ctx.scheduler.stop();
    await app.close();
    await ctx.ops.shutdown();
    ctx.db.close();
  } finally {
    process.exit(0);
  }
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (err) => console.error('[zaliv] unhandledRejection', err));
