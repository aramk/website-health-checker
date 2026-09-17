import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = process.env.DATA_DIR || join(rootDir, 'data');
mkdirSync(dataDir, { recursive: true });

export const RETENTION_DAYS = 365;

const db = new DatabaseSync(join(dataDir, 'health.db'));
db.exec('PRAGMA journal_mode = WAL;');
db.exec(`
  CREATE TABLE IF NOT EXISTS sites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    url TEXT NOT NULL UNIQUE,
    refresh_sec INTEGER,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
  CREATE TABLE IF NOT EXISTS checks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    checked_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    status_code INTEGER,
    ok INTEGER NOT NULL,
    response_time_ms INTEGER,
    error TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_checks_site_time ON checks (site_id, checked_at DESC, id DESC);
`);

// --- migrations ---
// v0.2.2: refresh interval is stored in seconds (was milliseconds).
{
  const cols = db.prepare('PRAGMA table_info(sites)').all().map((c) => c.name);
  if (!cols.includes('refresh_sec')) {
    db.exec('ALTER TABLE sites ADD COLUMN refresh_sec INTEGER');
    if (cols.includes('refresh_ms')) {
      db.exec('UPDATE sites SET refresh_sec = CAST(ROUND(refresh_ms / 1000.0) AS INTEGER)');
      try {
        db.exec('ALTER TABLE sites DROP COLUMN refresh_ms');
      } catch (err) {
        console.error('[db] could not drop legacy refresh_ms column:', err.message);
      }
    }
    console.log('[db] migrated: sites.refresh_ms (ms) -> sites.refresh_sec (s)');
  }
}

export function listSites() {
  return db.prepare('SELECT id, name, url, refresh_sec, created_at FROM sites ORDER BY name').all();
}

export function addSite(name, url, refreshSec = null) {
  const info = db
    .prepare('INSERT INTO sites (name, url, refresh_sec) VALUES (?, ?, ?)')
    .run(name, url, refreshSec);
  return { id: Number(info.lastInsertRowid), name, url, refreshSec };
}

/**
 * Insert settings-file sites; on URL conflict update the name and the
 * per-site refresh (a null refresh in settings keeps whatever is stored).
 */
export function upsertSites(sites) {
  const stmt = db.prepare(`
    INSERT INTO sites (name, url, refresh_sec) VALUES (?, ?, ?)
    ON CONFLICT(url) DO UPDATE SET
      name = excluded.name,
      refresh_sec = COALESCE(excluded.refresh_sec, sites.refresh_sec)
  `);
  let n = 0;
  for (const s of sites) {
    stmt.run(s.name, s.url, s.refreshSec ?? null);
    n++;
  }
  return n;
}

export function updateSite(id, { name, refreshSec }) {
  const existing = db.prepare('SELECT id FROM sites WHERE id = ?').get(id);
  if (!existing) return null;
  if (name !== undefined) db.prepare('UPDATE sites SET name = ? WHERE id = ?').run(name, id);
  if (refreshSec !== undefined) db.prepare('UPDATE sites SET refresh_sec = ? WHERE id = ?').run(refreshSec, id);
  return db.prepare('SELECT id, name, url, refresh_sec, created_at FROM sites WHERE id = ?').get(id);
}

export function removeSite(id) {
  db.prepare('DELETE FROM checks WHERE site_id = ?').run(id);
  return db.prepare('DELETE FROM sites WHERE id = ?').run(id).changes > 0;
}

export function recordCheck(siteId, { status_code, ok, response_time_ms, error }) {
  db.prepare(
    'INSERT INTO checks (site_id, status_code, ok, response_time_ms, error) VALUES (?, ?, ?, ?, ?)'
  ).run(siteId, status_code, ok ? 1 : 0, response_time_ms, error);
}

/** Delete checks older than the retention window. Returns rows removed. */
export function pruneOld(retentionDays = RETENTION_DAYS) {
  return db
    .prepare(`DELETE FROM checks WHERE checked_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?)`)
    .run(`-${retentionDays} days`).changes;
}

/** One row per site with its most recent check (null when never checked). */
export function latestPerSite() {
  return db.prepare(`
    SELECT s.id, s.name, s.url, s.refresh_sec, s.created_at,
           c.checked_at, c.status_code, c.ok, c.response_time_ms, c.error
    FROM sites s
    LEFT JOIN checks c ON c.id = (
      SELECT id FROM checks WHERE site_id = s.id ORDER BY checked_at DESC, id DESC LIMIT 1
    )
    ORDER BY s.name
  `).all();
}

export function history(siteId, limit = 60) {
  return db
    .prepare(
      'SELECT checked_at, status_code, ok, response_time_ms, error FROM checks WHERE site_id = ? ORDER BY checked_at DESC, id DESC LIMIT ?'
    )
    .all(siteId, limit);
}

/** Percentage of successful checks in the window (e.g. '-24 hours'), or null. */
export function uptime(siteId, window) {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS total, COALESCE(SUM(ok), 0) AS up FROM checks
       WHERE site_id = ? AND checked_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?)`
    )
    .get(siteId, window);
  if (!row || row.total === 0) return null;
  return Math.round((row.up / row.total) * 1000) / 10;
}

export const uptime24h = (id) => uptime(id, '-24 hours');
export const uptime7d = (id) => uptime(id, '-7 days');
export const uptime30d = (id) => uptime(id, '-30 days');

/** Average response time (seconds, 2 decimals) of successful checks in the last 24h, or null. */
export function avgLatencySec(siteId) {
  const row = db
    .prepare(
      `SELECT AVG(response_time_ms) AS avg FROM checks
       WHERE site_id = ? AND ok = 1 AND response_time_ms IS NOT NULL
         AND checked_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-24 hours')`
    )
    .get(siteId);
  return row && row.avg != null ? Math.round((row.avg / 1000) * 100) / 100 : null;
}
