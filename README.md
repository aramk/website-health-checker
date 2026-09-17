# website-health-checker

A tiny self-hosted website monitor. A Node.js server checks your sites on a
schedule, stores every result in a local SQLite file, and serves a dashboard
with the latest status, latency, uptime (24h / 7d / 30d), and recent history.

Zero npm dependencies — just Node.js 26+ (uses the built-in `node:sqlite`).

## Run it

```sh
npm start
# dashboard at http://localhost:3000
```

## Configuration

### settings.json

Copy `settings-example.json` to `settings.json` (gitignored — your local
config never gets committed):

```json
{
  "defaultRefreshMs": 300000,
  "sites": [
    { "name": "Example", "url": "https://example.com" },
    { "name": "My blog", "url": "https://example.com/blog", "refreshMs": 60000 }
  ]
}
```

- `defaultRefreshMs` — how often every site is checked (default: 5 minutes).
- `sites` — sites to monitor. Each has `name`, `url`, and an optional
  `refreshMs` that overrides the default for that site.
- On startup the listed sites are **upserted** into the database (matched by
  URL): new ones are added, and the name / per-site refresh of existing ones
  is updated. A `refreshMs` omitted in the file keeps whatever is stored.
- Edit `settings.json` and restart the server to apply changes.

### Env vars

| Var                | Default    | What it does                              |
| ------------------ | ---------- | ----------------------------------------- |
| `PORT`             | `3000`     | HTTP port for the dashboard + API         |
| `CHECK_TIMEOUT_MS` | `10000`    | Per-request timeout; slower = down        |
| `DATA_DIR`         | `./data`   | Directory holding the `health.db` SQLite file |
| `SETTINGS_PATH`    | `./settings.json` | Where to read settings from          |

## API

- `GET /` — dashboard
- `GET /api/health` — server health
- `GET /api/sites` — all sites: latest check, effective `refreshMs`, and `uptime24h` / `uptime7d` / `uptime30d`
- `POST /api/sites` — `{name, url, refreshMs?}` → 201 (409 if the URL is already monitored)
- `PATCH /api/sites/:id` — `{name?, refreshMs?}` (`refreshMs: null` resets to the default)
- `DELETE /api/sites/:id` — stop monitoring (deletes history too)
- `GET /api/sites/:id/checks?limit=60` — recent check history

`refreshMs` is in milliseconds, minimum 5000. The scheduler wakes every
10 seconds and checks the sites that are due.

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
settings-example.json  # copy to settings.json to configure
data/
  health.db      # created on first run (gitignored)
```
