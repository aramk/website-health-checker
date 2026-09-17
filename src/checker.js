import { latestPerSite, recordCheck, pruneOld, RETENTION_DAYS } from './db.js';

const TICK_MS = 10_000; // scheduler granularity: due sites are picked up each tick
const PRUNE_EVERY_MS = 24 * 60 * 60 * 1000;

const fmtSec = (ms) => `${parseFloat((ms / 1000).toFixed(2))}s`;

/**
 * Check one URL. Resolves to { status_code, ok, response_time_ms, error }.
 * A site counts as up when it answers with a 2xx/3xx status in time.
 * (response_time_ms stays millisecond-precise internally; boundaries use seconds.)
 */
export async function checkSite(url, timeoutSec) {
  const started = Date.now();
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutSec * 1000),
      redirect: 'follow',
      headers: { 'user-agent': 'website-health-checker/0.2.2' },
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

/**
 * Every TICK_MS, check sites whose last check is older than their refresh
 * interval. getRefreshSec(site) resolves the effective interval in seconds.
 */
export function startScheduler({ timeoutSec, getRefreshSec, retentionDays = RETENTION_DAYS }) {
  let lastPrune = 0;

  const tick = async () => {
    const now = Date.now();

    if (now - lastPrune >= PRUNE_EVERY_MS) {
      try {
        const n = pruneOld(retentionDays);
        if (n > 0) console.log(`[db] pruned ${n} check(s) older than ${retentionDays} days`);
      } catch (err) {
        console.error('[db] prune failed:', err.message);
      }
      lastPrune = now;
    }

    const sites = latestPerSite();
    const due = sites.filter((s) => {
      if (!s.checked_at) return true; // never checked
      return now - new Date(s.checked_at).getTime() >= getRefreshSec(s) * 1000;
    });
    if (!due.length) return;

    await Promise.allSettled(
      due.map(async (site) => {
        const result = await checkSite(site.url, timeoutSec);
        recordCheck(site.id, result);
        console.log(
          `[check] ${site.url} -> ${result.ok ? 'UP' : 'DOWN'}` +
            ` ${result.status_code ?? '-'}` +
            ` ${fmtSec(result.response_time_ms)}` +
            (result.error ? ` :: ${result.error}` : '')
        );
      })
    );
  };

  tick().catch((err) => console.error('[scheduler] initial tick failed:', err));
  return setInterval(() => {
    tick().catch((err) => console.error('[scheduler] tick failed:', err));
  }, TICK_MS);
}
