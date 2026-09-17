import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');

export const DEFAULT_REFRESH_MS = 5 * 60 * 1000; // 5 minutes

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
  const refreshMs = Number(entry.refreshMs);
  return { name, url, refreshMs: refreshMs > 0 ? refreshMs : null };
}

/**
 * Load ./settings.json (or SETTINGS_PATH). Missing file -> defaults with no
 * sites. Invalid JSON -> defaults with a warning. Never throws.
 */
export function loadSettings() {
  const path = process.env.SETTINGS_PATH || join(rootDir, 'settings.json');
  if (!existsSync(path)) return { defaultRefreshMs: DEFAULT_REFRESH_MS, sites: [], path, found: false };

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    console.error(`[settings] invalid JSON in ${path}, using defaults: ${err.message}`);
    return { defaultRefreshMs: DEFAULT_REFRESH_MS, sites: [], path, found: true };
  }

  const defaultRefreshMs =
    Number(parsed?.defaultRefreshMs) > 0 ? Number(parsed.defaultRefreshMs) : DEFAULT_REFRESH_MS;

  const sites = [];
  if (Array.isArray(parsed?.sites)) {
    for (const entry of parsed.sites) {
      const site = cleanSite(entry);
      if (site) sites.push(site);
      else console.error(`[settings] skipping invalid site entry: ${JSON.stringify(entry)?.slice(0, 120)}`);
    }
  }

  return { defaultRefreshMs, sites, path, found: true };
}
