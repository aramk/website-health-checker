import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = process.env.DATA_DIR || join(rootDir, 'data');
mkdirSync(dataDir, { recursive: true });

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

const KEEP_PER_SITE = 2000;

export function listSites() {
  return db.prepare('SELECT id, name, url, created_at FROM sites ORDER BY name').all();
}

export function addSite(name, url) {
  const info = db.prepare('INSERT INTO sites (name, url) VALUES (?, ?)').run(name, url);
  return { id: Number(info.lastInsertRowid), name, url };
}

export function removeSite(id) {
  db.prepare('DELETE FROM checks WHERE site_id = ?').run(id);
  return db.prepare('DELETE FROM sites WHERE id = ?').run(id).changes > 0;
}

export function recordCheck(siteId, { status_code, ok, response_time_ms, error }) {
  db.prepare(
    'INSERT INTO checks (site_id, status_code, ok, response_time_ms, error) VALUES (?, ?, ?, ?, ?)'
  ).run(siteId, status_code, ok ? 1 : 0, response_time_ms, error);
  db.prepare(
    `DELETE FROM checks WHERE site_id = ? AND id NOT IN
     (SELECT id FROM checks WHERE site_id = ? ORDER BY id DESC LIMIT ?)`
  ).run(siteId, siteId, KEEP_PER_SITE);
}

/** One row per site with its most recent check (null when never checked). */
export function latestPerSite() {
  return db.prepare(`
    SELECT s.id, s.name, s.url, s.created_at,
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

/** Percentage of successful checks in the last 24h, or null when no data. */
export function uptime24h(siteId) {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS total, COALESCE(SUM(ok), 0) AS up FROM checks
       WHERE site_id = ? AND checked_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-24 hours')`
    )
    .get(siteId);
  if (!row || row.total === 0) return null;
  return Math.round((row.up / row.total) * 1000) / 10;
}
