// Polls the remote-browser screenshot into an <img>: one request at a time, paused while the tab is hidden.
import { api } from './api.js';

export function screenLoop({ accountId, img, interval = 700, missingDelay = 3000, enabled = () => true, onFrame, onMissing, onError }) {
  let stopped = false, timer = 0, busy = false, lastUrl = '';
  const path = `/api/accounts/${accountId}/browser/screenshot`;
  const schedule = (ms) => { clearTimeout(timer); if (!stopped) timer = setTimeout(tick, ms); };

  async function tick() {
    if (stopped || busy || document.hidden) return; // visibilitychange restarts the loop
    if (!enabled()) { schedule(interval * 2); return; } // no browser: do not hammer the server with 404s
    busy = true;
    let delay = interval;
    try {
      const blob = await api.blob(path, { t: Date.now() });
      if (stopped) return;
      const url = URL.createObjectURL(blob);
      img.src = url;
      try { await img.decode(); } catch { /* skip a broken frame */ }
      if (lastUrl) URL.revokeObjectURL(lastUrl);
      lastUrl = url;
      onFrame?.();
    } catch (error) {
      if (stopped) return;
      if (error.status === 404) { delay = missingDelay; onMissing?.(); } else onError?.(error);
    } finally {
      busy = false;
      schedule(delay);
    }
  }

  const onVisibility = () => { if (!document.hidden) { clearTimeout(timer); tick(); } };
  document.addEventListener('visibilitychange', onVisibility);
  tick();
  return {
    poke() { if (!stopped && !busy) schedule(80); },
    stop() {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
      if (lastUrl) URL.revokeObjectURL(lastUrl);
      lastUrl = '';
    }
  };
}
