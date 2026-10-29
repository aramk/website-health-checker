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

function normalizeIsoDate(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const date = new Date(trimmed);
  return Number.isNaN(date.getTime()) ? null : trimmed;
}

function cleanSite(entry) {
  if (!entry || typeof entry.name !== 'string' || typeof entry.url !== 'string') return null;
  const name = entry.name.trim();
  const url = entry.url.trim();
  if (!name || !validUrl(url)) return null;
  const refreshSec = Number(entry.refreshSec);
  const lastNotifiedAt = normalizeIsoDate(entry.lastNotifiedAt);
  return {
    name,
    url,
    refreshSec: refreshSec > 0 ? Math.max(Math.round(refreshSec), MIN_REFRESH_SEC) : null,
    ...(lastNotifiedAt ? { lastNotifiedAt } : {}),
  };
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

  const notifications = parsed?.notifications && typeof parsed.notifications === 'object'
    ? {
        email: {
          enabled: Boolean(parsed.notifications.email?.enabled ?? parsed.notifications.enabled),
          rootUrl: typeof parsed.notifications.email?.rootUrl === 'string'
            ? parsed.notifications.email.rootUrl.trim()
            : typeof parsed.notifications.rootUrl === 'string'
              ? parsed.notifications.rootUrl.trim()
              : '',
          mailUrl: typeof parsed.notifications.email?.mailUrl === 'string'
            ? parsed.notifications.email.mailUrl.trim()
            : typeof parsed.notifications.mailUrl === 'string'
              ? parsed.notifications.mailUrl.trim()
              : '',
          from: typeof parsed.notifications.email?.from === 'string'
            ? parsed.notifications.email.from.trim()
            : typeof parsed.notifications.from === 'string'
              ? parsed.notifications.from.trim()
              : '',
          recipients: Array.isArray(parsed.notifications.email?.recipients ?? parsed.notifications.recipients)
            ? (parsed.notifications.email?.recipients ?? parsed.notifications.recipients)
              .filter((recipient) => typeof recipient === 'string' && recipient.trim())
              .map((recipient) => recipient.trim())
            : [],
          groupFailuresIntoSingleEmail: Boolean(
            parsed.notifications.email?.groupFailuresIntoSingleEmail ?? parsed.notifications.groupFailuresIntoSingleEmail ?? true,
          ),
          notifyIntervalSec: Number(
            parsed.notifications.email?.notifyIntervalSec ?? parsed.notifications.notifyIntervalSec ?? parsed.notifications.email?.notify_every_sec ?? parsed.notifications.notify_every_sec ?? 3600,
          ) > 0
            ? Math.max(1, Math.round(Number(parsed.notifications.email?.notifyIntervalSec ?? parsed.notifications.notifyIntervalSec ?? parsed.notifications.email?.notify_every_sec ?? parsed.notifications.notify_every_sec ?? 3600)))
            : 3600,
          htmlTemplatePath: typeof parsed.notifications.email?.htmlTemplatePath === 'string'
            ? parsed.notifications.email.htmlTemplatePath.trim()
            : typeof parsed.notifications.htmlTemplatePath === 'string'
              ? parsed.notifications.htmlTemplatePath.trim()
              : '',
        },
      }
    : {
        email: {
          enabled: false,
          rootUrl: '',
          mailUrl: '',
          from: '',
          recipients: [],
          groupFailuresIntoSingleEmail: true,
          notifyIntervalSec: 3600,
          htmlTemplatePath: '',
        },
      };

  return { defaultRefreshSec, notifications, sites, path, found: true };
}
