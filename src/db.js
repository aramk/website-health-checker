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
for (const { table, name, ddl } of [{ table: 'sites', name: 'refresh_ms', ddl: 'INTEGER' }]) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === name)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`);
    console.log(`[db] migrated: added ${table}.${name}`);
  }
}

export function listSites() {
  return db.prepare('SELECT id, name, url, refresh_ms, created_at FROM sites ORDER BY name').all();
}

export function addSite(name, url, refreshMs = null) {
  const info = db
    .prepare('INSERT INTO sites (name, url, refresh_ms) VALUES (?, ?, ?)')
    .run(name, url, refreshMs);
  return { id: Number(info.lastInsertRowid), name, url, refreshMs };
}

/**
 * Insert settings-file sites; on URL conflict update the name and the
 * per-site refresh (a null refresh in settings keeps whatever is stored).
 */
export function upsertSites(sites) {
  const stmt = db.prepare(`
    INSERT INTO sites (name, url, refresh_ms) VALUES (?, ?, ?)
    ON CONFLICT(url) DO UPDATE SET
      name = excluded.name,
      refresh_ms = COALESCE(excluded.refresh_ms, sites.refresh_ms)
  `);
  let n = 0;
  for (const s of sites) {
    stmt.run(s.name, s.url, s.refreshMs ?? null);
    n++;
  }
  return n;
}

export function updateSite(id, { name, refreshMs }) {
  const existing = db.prepare('SELECT id FROM sites WHERE id = ?').get(id);
  if (!existing) return null;
  if (name !== undefined) db.prepare('UPDATE sites SET name = ? WHERE id = ?').run(name, id);
  if (refreshMs !== undefined) db.prepare('UPDATE sites SET refresh_ms = ? WHERE id = ?').run(refreshMs, id);
  return db.prepare('SELECT id, name, url, refresh_ms, created_at FROM sites WHERE id = ?').get(id);
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
    SELECT s.id, s.name, s.url, s.refresh_ms, s.created_at,
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
