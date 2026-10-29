# website-health-checker

A tiny self-hosted website monitor. A Node.js server checks your sites on a
schedule, stores every result in a local SQLite file, and serves a dashboard
with the latest status, average latency, uptime (24h / 7d / 30d), and recent
history.

Zero npm dependencies — just Node.js 26+ (uses the built-in `node:sqlite`).

## Run it

```sh
npm start
# dashboard at http://localhost:3000
```

On the first run, `settings.json` is created automatically from
`settings-example.json` (it's gitignored — your local config never gets
committed). Edit it and restart to configure your sites.

## Configuration

### settings.json

```json
{
  "defaultRefreshSec": 300,
  "notifications": {
    "email": {
      "enabled": true,
      "rootUrl": "https://status.example.com",
      "mailUrl": "smtp://user:pass@smtp.example.com:587",
      "from": "Website Health Alerts <alerts@example.com>",
      "recipients": ["ops@example.com", "oncall@example.com"],
      "notifyIntervalSec": 3600,
      "groupFailuresIntoSingleEmail": true,
      "htmlTemplatePath": "./templates/website-down-email.html"
    }
  },
  "sites": [
    {
      "name": "Google",
      "url": "https://www.google.com",
      "lastNotifiedAt": "2026-10-11T12:00:00.000Z"
    },
    {
      "name": "My blog",
      "url": "https://example.com/blog",
      "refreshSec": 60,
      "lastNotifiedAt": "2026-10-11T12:00:00.000Z"
    }
  ]
}
```
All times are in seconds, except `lastNotifiedAt`, which is an ISO-8601 timestamp for when the most recent email alert was sent for that site.

- `defaultRefreshSec` — how often every site is checked, in seconds (default: 300 = 5 minutes).
- `notifications.email` — optional alert settings for when a site goes down.
  - `enabled` — turns the alerting flow on or off.
  - `rootUrl` — public base URL of the dashboard, used as the `dashboardUrl` in the notification email.
  - `mailUrl` — URL for the outbound mail transport (for example `smtp://user:pass@smtp.example.com:587`).
  - `from` — sender address shown in the email.
  - `recipients` — list of recipients that should receive downtime alerts.
  - `notifyIntervalSec` — minimum seconds between alerts for the same site; defaults to 3600 (one hour).
  - `groupFailuresIntoSingleEmail` — prefer a single grouped alert email for all failing sites instead of one message per site.
  - `htmlTemplatePath` — path to an HTML email template used for the notification body.
- `sites` — sites to monitor. Each has `name`, `url`, and an optional
  `refreshSec` that overrides the default for that site (minimum 5; lower
  values are raised to 5). A site may also include `lastNotifiedAt` to record
  the last date that a website alert was emailed.
- On startup the listed sites are **upserted** into the database (matched by
  URL): new ones are added, and the name / per-site refresh of existing ones
  is updated. A `refreshSec` omitted in the file keeps whatever is stored.
- Edit `settings.json` and restart the server to apply changes.

### Env vars

| Var                | Default    | What it does                              |
| ------------------ | ---------- | ----------------------------------------- |
| `PORT`             | `3000`     | HTTP port for the dashboard + API         |
| `CHECK_TIMEOUT_SEC` | `10`       | Per-request timeout, in seconds; slower = down |
| `DATA_DIR`         | `./data`   | Directory holding the `health.db` SQLite file |
| `SETTINGS_PATH`    | `./settings.json` | Where to read settings from          |

## API

- `GET /` — dashboard
- `GET /api/health` — server health
- `GET /api/sites` — all sites: latest check, effective `refreshSec`, `avgLatencySec` (successful checks, last 24h), and `uptime24h` / `uptime7d` / `uptime30d`; plus the global `defaultRefreshSec`
- `POST /api/sites` — `{name, url, refreshSec?}` → 201 (409 if the URL is already monitored)
- `PATCH /api/sites/:id` — `{name?, refreshSec?}` (`refreshSec: null` resets to the default)
- `DELETE /api/sites/:id` — stop monitoring (deletes history too)
- `GET /api/sites/:id/checks?limit=60` — recent check history

`refreshSec` is in seconds, minimum 5. The scheduler wakes every
10 seconds and checks the sites that are due. The dashboard re-pulls data as
often as the fastest site's refresh interval (or the global default when no
sites are monitored).

A site counts as **up** when it answers with a 2xx/3xx status inside the
timeout. Check history is retained for one year per site, then pruned.

## Layout

```
src/
  server.js      # HTTP server, routes, API
  checker.js     # fetch-based probing + due-based scheduler
  db.js          # SQLite schema, migrations + queries (node:sqlite)
  settings.js    # settings.json loading + validation
  dashboard.html # dashboard UI (vanilla JS, auto-refreshes)
scripts/
  ensure-settings.js  # `prestart`: creates settings.json from the example
settings-example.json  # copied to settings.json on first `npm start`
data/
  health.db      # created on first run (gitignored)
```
