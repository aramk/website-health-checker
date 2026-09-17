import { listSites, recordCheck } from './db.js';

/**
 * Check one URL. Resolves to { status_code, ok, response_time_ms, error }.
 * A site counts as up when it answers with a 2xx/3xx status in time.
 */
export async function checkSite(url, timeoutMs) {
  const started = Date.now();
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'follow',
      headers: { 'user-agent': 'website-health-checker/0.1' },
    });
    try {
      await res.body?.cancel();
    } catch {
      // body already consumed/closed; nothing to do
    }
    const ms = Date.now() - started;
    const ok = res.status >= 200 && res.status < 400;
    return {
      status_code: res.status,
      ok,
      response_time_ms: ms,
      error: ok ? null : `HTTP ${res.status}`,
    };
  } catch (err) {
    const ms = Date.now() - started;
    const detail = err?.cause ? err.cause.message || err.cause.code || String(err.cause) : err.message;
    return {
      status_code: null,
      ok: false,
      response_time_ms: ms,
      error: `${err.name}: ${detail}`.slice(0, 500),
    };
  }
}

/** Run one check pass over every site, then repeat on the interval. */
export function startScheduler({ intervalMs, timeoutMs }) {
  const tick = async () => {
    const sites = listSites();
    await Promise.allSettled(
      sites.map(async (site) => {
        const result = await checkSite(site.url, timeoutMs);
        recordCheck(site.id, result);
        console.log(
          `[check] ${site.url} -> ${result.ok ? 'UP' : 'DOWN'}` +
            ` ${result.status_code ?? '-'}` +
            ` ${result.response_time_ms}ms` +
            (result.error ? ` :: ${result.error}` : '')
        );
      })
    );
  };
  tick().catch((err) => console.error('[scheduler] initial tick failed:', err));
  return setInterval(() => {
    tick().catch((err) => console.error('[scheduler] tick failed:', err));
  }, intervalMs);
}
