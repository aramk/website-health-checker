import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');

export const DEFAULT_REFRESH_SEC = 300; // 5 minutes
export const MIN_REFRESH_SEC = 5;

export function validUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function cleanSite(entry) {
  if (!entry || typeof entry.name !== 'string' || typeof entry.url !== 'string') return null;
  const name = entry.name.trim();
  const url = entry.url.trim();
  if (!name || !validUrl(url)) return null;
  const refreshSec = Number(entry.refreshSec);
  return { name, url, refreshSec: refreshSec > 0 ? Math.max(Math.round(refreshSec), MIN_REFRESH_SEC) : null };
}

/**
 * Load ./settings.json (or SETTINGS_PATH). Missing file -> defaults with no
 * sites. Invalid JSON -> defaults with a warning. Never throws.
 * All times are in seconds.
 */
export function loadSettings() {
  const path = process.env.SETTINGS_PATH || join(rootDir, 'settings.json');
  if (!existsSync(path)) return { defaultRefreshSec: DEFAULT_REFRESH_SEC, sites: [], path, found: false };

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    console.error(`[settings] invalid JSON in ${path}, using defaults: ${err.message}`);
    return { defaultRefreshSec: DEFAULT_REFRESH_SEC, sites: [], path, found: true };
  }

  const defaultRefreshSec =
    Number(parsed?.defaultRefreshSec) > 0 ? Number(parsed.defaultRefreshSec) : DEFAULT_REFRESH_SEC;

  const sites = [];
  if (Array.isArray(parsed?.sites)) {
    for (const entry of parsed.sites) {
      const site = cleanSite(entry);
      if (site) sites.push(site);
      else console.error(`[settings] skipping invalid site entry: ${JSON.stringify(entry)?.slice(0, 120)}`);
    }
  }

  return { defaultRefreshSec, sites, path, found: true };
}
