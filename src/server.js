import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  addSite,
  updateSite,
  removeSite,
  upsertSites,
  latestPerSite,
  history,
  uptime24h,
  uptime7d,
  uptime30d,
} from './db.js';
import { loadSettings, validUrl } from './settings.js';
import { startScheduler } from './checker.js';

const dir = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const CHECK_TIMEOUT_MS = Number(process.env.CHECK_TIMEOUT_MS || 10_000);
const MIN_REFRESH_MS = 5_000;

const settings = loadSettings();
if (settings.found) {
  const n = upsertSites(settings.sites);
  console.log(`[settings] loaded ${settings.path} (default refresh ${settings.defaultRefreshMs}ms, ${n} site(s) upserted)`);
} else {
  console.log(`[settings] no settings.json found, using defaults (refresh ${settings.defaultRefreshMs}ms)`);
}

const getRefreshMs = (site) => site.refresh_ms ?? settings.defaultRefreshMs;

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1e6) throw new Error('request body too large');
  }
  return raw ? JSON.parse(raw) : {};
}

/** refreshMs from user input. undefined = not provided, null = reset to default. Throws on invalid. */
function parseRefreshMs(value) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms <= 0)
    throw new Error(`refreshMs must be a positive number of milliseconds (min ${MIN_REFRESH_MS})`);
  return Math.max(Math.round(ms), MIN_REFRESH_MS);
}

function toApiSite(s) {
  return {
    id: s.id,
    name: s.name,
    url: s.url,
    created_at: s.created_at,
    refreshMs: s.refresh_ms ?? settings.defaultRefreshMs,
    defaultRefreshMs: settings.defaultRefreshMs,
    uptime24h: uptime24h(s.id),
    uptime7d: uptime7d(s.id),
    uptime30d: uptime30d(s.id),
    latest: s.checked_at
      ? {
          checked_at: s.checked_at,
          status_code: s.status_code,
          ok: Boolean(s.ok),
          response_time_ms: s.response_time_ms,
          error: s.error,
        }
      : null,
  };
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const { pathname } = url;

    if (req.method === 'GET' && pathname === '/') {
      const html = await readFile(join(dir, 'dashboard.html'), 'utf8');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(html);
    }

    if (req.method === 'GET' && pathname === '/api/health') {
      return sendJson(res, 200, { ok: true, time: new Date().toISOString() });
    }

    if (req.method === 'GET' && pathname === '/api/sites') {
      return sendJson(res, 200, { sites: latestPerSite().map(toApiSite) });
    }

    const siteMatch = pathname.match(/^\/api\/sites\/(\d+)(\/checks)?$/);
    if (siteMatch && !siteMatch[2]) {
      const id = Number(siteMatch[1]);
      if (req.method === 'PATCH') {
        const body = await readJson(req);
        const patch = {};
        if (body.name !== undefined) {
          const name = String(body.name).trim();
          if (!name) return sendJson(res, 400, { error: 'name must not be empty' });
          patch.name = name;
        }
        if (body.refreshMs !== undefined) {
          try {
            patch.refreshMs = parseRefreshMs(body.refreshMs);
          } catch (err) {
            return sendJson(res, 400, { error: err.message });
          }
        }
        const site = updateSite(id, patch);
        if (!site) return sendJson(res, 404, { error: 'not found' });
        const full = latestPerSite().find((s) => s.id === id);
        return sendJson(res, 200, { site: toApiSite(full) });
      }
      if (req.method === 'DELETE') {
        if (!removeSite(id)) return sendJson(res, 404, { error: 'not found' });
        res.writeHead(204);
        return res.end();
      }
    }

    if (req.method === 'GET' && siteMatch?.[2] === '/checks') {
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 60, 1), 500);
      return sendJson(res, 200, { checks: history(Number(siteMatch[1]), limit) });
    }

    if (req.method === 'POST' && pathname === '/api/sites') {
      const body = await readJson(req);
      const name = String(body.name || '').trim();
      const siteUrl = String(body.url || '').trim();
      if (!name) return sendJson(res, 400, { error: 'name is required' });
      if (!validUrl(siteUrl)) return sendJson(res, 400, { error: 'url must be a valid http(s) URL' });
      let refreshMs = null;
      if (body.refreshMs !== undefined) {
        try {
          refreshMs = parseRefreshMs(body.refreshMs);
        } catch (err) {
          return sendJson(res, 400, { error: err.message });
        }
      }
      try {
        const site = addSite(name, siteUrl, refreshMs);
        const full = latestPerSite().find((s) => s.id === site.id);
        return sendJson(res, 201, { site: toApiSite(full) });
      } catch (err) {
        if (String(err.message).includes('UNIQUE')) {
          return sendJson(res, 409, { error: 'that URL is already being monitored' });
        }
        throw err;
      }
    }

    return sendJson(res, 404, { error: 'not found' });
  } catch (err) {
    console.error('[server] request failed:', err);
    return sendJson(res, 500, { error: 'internal server error' });
  }
});

server.listen(PORT, () => {
  console.log(`[server] dashboard at http://localhost:${PORT}`);
  console.log(`[server] scheduler tick 10s, per-site refresh (default ${settings.defaultRefreshMs}ms), timeout ${CHECK_TIMEOUT_MS}ms`);
  startScheduler({ timeoutMs: CHECK_TIMEOUT_MS, getRefreshMs });
});
