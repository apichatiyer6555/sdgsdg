// Tiny in-memory sliding-window limiter (single process is enough for this panel).
export function createLimiter({ max, windowMs }) {
  const hits = new Map();
  const timer = setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [key, list] of hits) {
      const fresh = list.filter((t) => t > cutoff);
      if (fresh.length) hits.set(key, fresh); else hits.delete(key);
    }
  }, Math.min(windowMs, 60_000));
  timer.unref();

  const prune = (key) => {
    const cutoff = Date.now() - windowMs;
    const fresh = (hits.get(key) || []).filter((t) => t > cutoff);
    hits.set(key, fresh);
    return fresh;
  };

  return {
    // Is another attempt allowed right now (does not count it)?
    check(key) {
      const list = prune(key);
      if (list.length < max) return { allowed: true, retryAfterSec: 0 };
      return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((list[0] + windowMs - Date.now()) / 1000)) };
    },
    fail(key) { prune(key).push(Date.now()); },
    reset(key) { hits.delete(key); },
    stop() { clearInterval(timer); }
  };
}
