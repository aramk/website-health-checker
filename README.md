# website-health-checker

A tiny self-hosted website monitor. A Node.js server checks your sites on a
schedule, stores every result in a local SQLite file, and serves a dashboard
with the latest status, latency, 24h uptime, and recent history.

Zero npm dependencies — just Node.js 22.5+ (uses the built-in `node:sqlite`).

## Run it

```sh
npm start
# dashboard at http://localhost:3000
```

Add sites from the dashboard, or via the API:

```sh
curl -X POST localhost:3000/api/sites \
  -H 'content-type: application/json' \
  -d '{"name":"My blog","url":"https://example.com"}'
```

## Configuration (env vars)

| Var                | Default    | What it does                              |
| ------------------ | ---------- | ----------------------------------------- |
| `PORT`             | `3000`     | HTTP port for the dashboard + API         |
| `CHECK_INTERVAL_MS`| `60000`    | How often every site is checked           |
| `CHECK_TIMEOUT_MS` | `10000`    | Per-request timeout; slower = down        |
| `DATA_DIR`         | `./data`   | Directory holding the `health.db` SQLite file |

## API

- `GET /` — dashboard
- `GET /api/health` — server health
- `GET /api/sites` — all sites with latest check + 24h uptime
- `POST /api/sites` — `{name, url}` → 201 (409 if the URL is already monitored)
- `DELETE /api/sites/:id` — stop monitoring (deletes history too)
- `GET /api/sites/:id/checks?limit=60` — recent check history

A site counts as **up** when it answers with a 2xx/3xx status inside the
timeout. History is capped at the 2000 most recent checks per site.

## Layout

```
src/
  server.js      # HTTP server, routes, API
  checker.js     # fetch-based probing + scheduler
  db.js          # SQLite schema + queries (node:sqlite)
  dashboard.html # dashboard UI (vanilla JS, auto-refreshes)
data/
  health.db      # created on first run (gitignored)
```
