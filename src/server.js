import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addSite, removeSite, latestPerSite, history, uptime24h } from './db.js';
import { startScheduler } from './checker.js';

const dir = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const CHECK_INTERVAL_MS = Number(process.env.CHECK_INTERVAL_MS || 60_000);
const CHECK_TIMEOUT_MS = Number(process.env.CHECK_TIMEOUT_MS || 10_000);

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

function validUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
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
      const sites = latestPerSite().map((s) => ({
        id: s.id,
        name: s.name,
        url: s.url,
        created_at: s.created_at,
        uptime24h: uptime24h(s.id),
        latest: s.checked_at
          ? {
              checked_at: s.checked_at,
              status_code: s.status_code,
              ok: Boolean(s.ok),
              response_time_ms: s.response_time_ms,
              error: s.error,
            }
          : null,
      }));
      return sendJson(res, 200, { sites });
    }

    const histMatch = pathname.match(/^\/api\/sites\/(\d+)\/checks$/);
    if (req.method === 'GET' && histMatch) {
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 60, 1), 500);
      return sendJson(res, 200, { checks: history(Number(histMatch[1]), limit) });
    }

    if (req.method === 'POST' && pathname === '/api/sites') {
      const body = await readJson(req);
      const name = String(body.name || '').trim();
      const siteUrl = String(body.url || '').trim();
      if (!name) return sendJson(res, 400, { error: 'name is required' });
      if (!validUrl(siteUrl)) return sendJson(res, 400, { error: 'url must be a valid http(s) URL' });
      try {
        const site = addSite(name, siteUrl);
        return sendJson(res, 201, { site });
      } catch (err) {
        if (String(err.message).includes('UNIQUE')) {
          return sendJson(res, 409, { error: 'that URL is already being monitored' });
        }
        throw err;
      }
    }

    const delMatch = pathname.match(/^\/api\/sites\/(\d+)$/);
    if (req.method === 'DELETE' && delMatch) {
      if (!removeSite(Number(delMatch[1]))) return sendJson(res, 404, { error: 'not found' });
      res.writeHead(204);
      return res.end();
    }

    return sendJson(res, 404, { error: 'not found' });
  } catch (err) {
    console.error('[server] request failed:', err);
    return sendJson(res, 500, { error: 'internal server error' });
  }
});

server.listen(PORT, () => {
  console.log(`[server] dashboard at http://localhost:${PORT}`);
  console.log(`[server] checking sites every ${CHECK_INTERVAL_MS}ms (timeout ${CHECK_TIMEOUT_MS}ms)`);
  startScheduler({ intervalMs: CHECK_INTERVAL_MS, timeoutMs: CHECK_TIMEOUT_MS });
});
