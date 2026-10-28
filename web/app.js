// Zaliv SPA: auth flow, shell (sidebar + top bar), hash router, global polling.
import { h, $, fill } from './lib/dom.js';
import { icon } from './lib/icons.js';
import { api, setAuthHooks, setCsrf } from './lib/api.js';
import { session, canEdit, accounts, on, startPolling, resetStore } from './lib/store.js';
import { openMenu, closeAllLayers, hasOpenLayer, getTheme, setTheme, errorState, loadingBlock } from './lib/ui.js';
import { startRelTicker } from './lib/format.js';
import { parseHash } from './lib/router.js';
import { ROLE_LABEL } from './lib/status.js';
import { showLogin, showForcedChange } from './views/login.js';
import { initCodeAutoOpen } from './views/account-code.js';
import { syncAll } from './views/account-actions.js';

const ROUTES = {
  dashboard: { title: 'Обзор', icon: 'grid', load: () => import('./views/dashboard.js') },
  accounts: { title: 'Аккаунты', icon: 'users', load: () => import('./views/accounts.js') },
  'ad-accounts': { title: 'Рекламные кабинеты', icon: 'building', load: () => import('./views/ad-accounts.js') },
  journal: { title: 'Журнал', icon: 'list', load: () => import('./views/journal.js') },
  modules: { title: 'Возможности', icon: 'layers', load: () => import('./views/modules.js') },
  settings: { title: 'Настройки', icon: 'sliders', load: () => import('./views/settings.js') }
};

const current = { token: 0, unmount: null };
const disposers = [];
let inApp = false;
let shell = null;

/* ---------- auth flow ---------- */
function showLoginScreen(notice = '') {
  showLogin({ notice, onSuccess: enter });
}
function enter({ user, csrf }) {
  setCsrf(csrf);
  session.user = user;
  if (user.mustChangePassword) showForcedScreen(); else showApp();
}
function showForcedScreen() {
  showForcedChange({
    user: session.user,
    onDone: async () => { enter(await api.get('/api/auth/me', undefined, { auth: false })); },
    onLogout: logout
  });
}
async function logout() {
  try { await api.post('/api/auth/logout'); } catch { /* the session is dropped locally either way */ }
  leaveApp();
  setCsrf('');
  showLoginScreen();
}
function leaveApp() {
  inApp = false;
  window.removeEventListener('hashchange', render);
  for (const dispose of disposers.splice(0)) dispose();
  current.token += 1;
  current.unmount?.();
  current.unmount = null;
  closeAllLayers();
  resetStore();
  document.title = 'Zaliv — TikTok Ads Hub';
}
setAuthHooks({
  unauthorized() {
    if (!inApp && !session.user) return;
    leaveApp();
    setCsrf('');
    showLoginScreen('Сессия завершилась. Войдите снова.');
  },
  mustChange() {
    if (!session.user) return;
    const user = { ...session.user, mustChangePassword: true };
    leaveApp();
    session.user = user;
    showForcedScreen();
  }
});

/* ---------- shell ---------- */
function drawPill(pill, sys) {
  if (!sys) { fill(pill, h('div', { class: 'sp-head' }, h('span', { class: 'dot' }), h('span', { class: 'sp-text' }, 'Состояние…'))); return; }
  const ready = !!sys.browser?.ready;
  const i = sys.browser?.interactive ?? {}, b = sys.browser?.background ?? {}, s = sys.scheduler ?? {};
  const sessions = `Сессии: ${i.active ?? 0}/${i.max ?? 0} · фон ${b.active ?? 0}/${b.max ?? 0}${b.queued ? ` (+${b.queued})` : ''}`;
  const auto = s.enabled ? `Автосинк: каждые ${s.intervalMin} мин` : 'Автосинк выключен';
  pill.title = `${ready ? 'Браузер готов' : 'Браузер недоступен'}. ${sessions}. ${auto}`;
  fill(pill,
    h('div', { class: 'sp-head' }, h('span', { class: `dot ${ready ? 'ok' : 'err'}` }), h('span', { class: 'sp-text' }, ready ? 'Браузер готов' : 'Браузер недоступен')),
    h('div', { class: 'sp-text' }, sessions), h('div', { class: 'sp-text' }, auto));
}

function drawBadge(badge) {
  const waiting = accounts.items.filter((a) => a.status === 'need_code' || a.status === 'need_manual').length;
  badge.hidden = !waiting;
  badge.textContent = String(waiting);
  badge.title = `Ждут оператора: ${waiting}`;
}

async function syncAllClick(btn) {
  btn.disabled = true;
  await syncAll();
  btn.disabled = false;
}

function buildShell() {
  const user = session.user;
  const badge = h('span', { class: 'nav-badge' });
  const pill = h('div', { class: 'status-pill', role: 'status' });
  const nav = h('nav', { class: 'nav', 'aria-label': 'Разделы' }, Object.entries(ROUTES).map(([id, route]) =>
    h('a', { href: `#/${id}`, title: route.title, 'aria-label': route.title, dataset: { route: id } }, icon(route.icon, 19), h('span', { class: 'nav-label' }, route.title), id === 'accounts' ? badge : null)));
  const title = h('h1', { id: 'page-title' });
  const themeBtn = h('button', { class: 'icon-btn bordered', type: 'button', onclick: () => { setTheme(getTheme() === 'dark' ? 'light' : 'dark'); paintTheme(); } });
  const paintTheme = () => {
    const dark = getTheme() === 'dark';
    themeBtn.title = dark ? 'Светлая тема' : 'Тёмная тема';
    themeBtn.setAttribute('aria-label', themeBtn.title);
    themeBtn.replaceChildren(icon(dark ? 'sun' : 'moon', 18));
  };
  paintTheme();
  const syncBtn = canEdit() ? h('button', { class: 'btn', type: 'button', title: 'Поставить в очередь синхронизацию всех активных аккаунтов', onclick: (e) => syncAllClick(e.currentTarget) },
    icon('refresh', 16), h('span', { class: 'sync-all-label' }, 'Синхронизировать всё')) : null;
  const userBtn = h('button', { class: 'user-btn', type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false', onclick: (e) => openMenu(e.currentTarget, [
    { label: `${user.login} · ${ROLE_LABEL[user.role] ?? user.role}`, icon: 'user', disabled: true },
    { divider: true },
    { label: 'Настройки', icon: 'sliders', onClick: () => { location.hash = '#/settings'; } },
    { label: 'Выйти', icon: 'log-out', onClick: logout }
  ]) }, h('span', { class: 'avatar', 'aria-hidden': 'true' }, (user.login || '?').slice(0, 1)),
  h('span', { class: 'u-text' }, h('b', { class: 'ellipsis' }, user.login), h('small', null, ROLE_LABEL[user.role] ?? user.role)));

  const view = h('main', { id: 'view', class: 'view', tabindex: '-1' });
  fill($('#app'), h('div', { class: 'shell' },
    h('aside', { class: 'sidebar' },
      h('div', { class: 'brand' }, h('img', { src: '/assets/logo.svg', alt: '', width: 38, height: 38 }),
        h('div', { class: 'brand-text' }, h('b', null, 'Zaliv'), h('span', null, 'TikTok Ads Hub'))),
      nav, h('div', { class: 'sidebar-foot' }, pill)),
    h('div', { class: 'main-col' },
      h('header', { class: 'topbar' }, title, h('span', { class: 'spacer' }), syncBtn, themeBtn, userBtn),
      view)));
  shell = { view, title, nav };
  drawBadge(badge);
  drawPill(pill, null);
  disposers.push(on('accounts', () => drawBadge(badge)), on('system', (sys) => drawPill(pill, sys)));
}

function showApp() {
  inApp = true;
  buildShell();
  startRelTicker();
  disposers.push(initCodeAutoOpen());
  window.addEventListener('hashchange', render);
  startPolling();
  render();
}

/* ---------- router ---------- */
async function render() {
  const { name, params } = parseHash();
  if (!ROUTES[name]) { location.replace('#/dashboard'); return; }
  const token = ++current.token;
  closeAllLayers();
  current.unmount?.();
  current.unmount = null;
  const { view, title, nav } = shell;
  view.className = 'view';
  fill(view, loadingBlock());
  title.textContent = ROUTES[name].title;
  document.title = `${ROUTES[name].title} — Zaliv`;
  for (const link of nav.querySelectorAll('a')) {
    if (link.dataset.route === name) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
  }
  let mod;
  try { mod = await ROUTES[name].load(); } catch (error) {
    console.error(error);
    if (token === current.token) fill(view, errorState('Не удалось загрузить раздел. Обновите страницу.', render));
    return;
  }
  if (token !== current.token) return;
  fill(view);
  view.classList.toggle('fill', mod.layout === 'fill');
  try { current.unmount = mod.mount(view, { params, name }) ?? null; } catch (error) {
    console.error(error);
    fill(view, errorState(error.message, render));
  }
  view.scrollTop = 0;
}

/* "/" jumps to the page search box, like in most admin tools */
document.addEventListener('keydown', (e) => {
  if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey || hasOpenLayer() || !inApp) return;
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable) return;
  const search = $('[data-search]');
  if (search) { e.preventDefault(); search.focus(); search.select(); }
});

async function boot() {
  try {
    enter(await api.get('/api/auth/me', undefined, { auth: false }));
  } catch (error) {
    if (error.status === 401) showLoginScreen();
    else fill($('#app'), errorState(error.message, () => location.reload()));
  }
}
boot();
