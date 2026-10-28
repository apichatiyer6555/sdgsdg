import { HttpError, badRequest } from '../lib/errors.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const finite = (v, name) => {
  const n = Number(v);
  if (!Number.isFinite(n)) throw badRequest(`${name}: нужно число.`);
  return n;
};

// A live Chromium page owned by one login: used by the login flow and by "assist" browsers.
// The operator sees JPEG screenshots and sends clicks / keys back (captcha, odd steps, manual work).
export class InteractiveSession {
  constructor({ kind, accountId, context, page, allowedHosts = [] }) {
    this.kind = kind;
    this.accountId = accountId;
    this.context = context;
    this.page = page;
    this.allowedHosts = allowedHosts;
    this.state = 'starting';
    this.message = '';
    this.lastActivity = Date.now();
    this.closed = false;
    this.shot = null;
    this.shotAt = 0;
    this.mouse = null;
    context.on('page', (p) => { this.page = p; });
    context.on('close', () => { this.closed = true; });
  }

  touch() { this.lastActivity = Date.now(); }

  #alive() {
    if (this.closed) throw new HttpError(409, 'Браузер уже закрыт.', 'no_browser');
    if (this.page.isClosed()) {
      const open = this.context.pages().filter((p) => !p.isClosed());
      if (!open.length) throw new HttpError(409, 'Страница закрыта.', 'no_browser');
      this.page = open[open.length - 1];
    }
    return this.page;
  }

  async info() {
    const base = { active: !this.closed, kind: this.kind, state: this.state, message: this.message, width: 0, height: 0, url: '', title: '' };
    if (this.closed) return { ...base, active: false };
    try {
      const page = this.#alive();
      const vp = page.viewportSize() || { width: 0, height: 0 };
      const title = await Promise.race([page.title(), sleep(400).then(() => '')]).catch(() => '');
      return { ...base, width: vp.width, height: vp.height, url: page.url().slice(0, 300), title };
    } catch { return { ...base, active: false }; }
  }

  async screenshot() {
    this.touch();
    const page = this.#alive();
    if (this.shot && Date.now() - this.shotAt < 250) return this.shot;
    try {
      this.shot = await page.screenshot({ type: 'jpeg', quality: 55, timeout: 8000, animations: 'disabled', caret: 'initial' });
      this.shotAt = Date.now();
      return this.shot;
    } catch (e) {
      throw new HttpError(409, `Не удалось сделать снимок: ${String(e.message).split('\n')[0].slice(0, 120)}`, 'no_browser');
    }
  }

  #allowedUrl(raw) {
    let url;
    try { url = new URL(raw); } catch { throw badRequest('Некорректный адрес.'); }
    const host = url.hostname.toLowerCase();
    const ok = url.protocol === 'https:' && (host === 'tiktok.com' || host.endsWith('.tiktok.com'));
    if (!ok && !this.allowedHosts.includes(host)) throw badRequest('Разрешены только адреса tiktok.com.');
    return url.toString();
  }

  async input(cmd) {
    this.touch();
    const page = this.#alive();
    const vp = page.viewportSize() || { width: 1366, height: 768 };
    const type = String(cmd?.type || '');
    try {
      switch (type) {
        case 'click':
        case 'dblclick': {
          const x = finite(cmd.x, 'x');
          const y = finite(cmd.y, 'y');
          if (x < 0 || y < 0 || x > vp.width || y > vp.height) throw badRequest('Координаты вне окна браузера.');
          await page.mouse.move(x, y, { steps: 4 });
          await page.mouse.click(x, y, { clickCount: type === 'dblclick' ? 2 : 1, delay: 40 });
          this.mouse = { x, y };
          break;
        }
        case 'type': {
          const text = String(cmd.text ?? '');
          if (!text || text.length > 500) throw badRequest('Текст: от 1 до 500 символов.');
          await page.keyboard.type(text, { delay: 20 });
          break;
        }
        case 'key': {
          const key = String(cmd.key ?? '');
          if (!/^[A-Za-z0-9+_ ]{1,40}$/.test(key)) throw badRequest('Некорректная клавиша.');
          await page.keyboard.press(key);
          break;
        }
        case 'scroll': {
          const dy = Math.max(-3000, Math.min(3000, finite(cmd.dy, 'dy')));
          const at = this.mouse || { x: vp.width / 2, y: vp.height / 2 };
          await page.mouse.move(at.x, at.y);
          await page.mouse.wheel(0, dy);
          break;
        }
        case 'navigate':
          await page.goto(this.#allowedUrl(String(cmd.url ?? '')), { waitUntil: 'domcontentloaded', timeout: 30_000 });
          break;
        default:
          throw badRequest('Неизвестная команда.');
      }
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(409, `Команда не выполнена: ${String(e.message).split('\n')[0].slice(0, 160)}`, 'input_failed');
    }
    this.shotAt = 0;
  }

  async storageState() {
    try { return await this.context.storageState(); } catch { return null; }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.context.close().catch(() => {});
  }
}
