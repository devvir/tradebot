# Catalog UI

A page for reading what the catalog holds, editing lenses, and starting and pausing surveys.

It stores nothing on the server and decides nothing. Every fact it shows comes from the catalog's API
or prospector's private API, through a proxy that adds `CATALOG_TOKEN` so the page never holds it.

```
http://localhost:9020
```

Deployed by: archives module (`modules/collect/archives/compose.yml`).
How it works, the proxy and what every column means: [docs/services/CATALOG-UI.md](../../docs/services/CATALOG-UI.md).

## What it shows

- **contents** — venues, then a venue's markets, then one row per `(dataset, variant, grain)` that
  market publishes. Symbol lists at venue and market level, asked for rather than loaded.
- **surveys** — what every venue is doing, polled every ten seconds, with Start per venue and
  pause/resume, update-now and refresh beside it, and start/pause across all of them.
- **lenses** — named selections of the catalog (sets of whole partitions), each edited as rules per
  venue and for all venues at once. A rule the catalog refuses is shown with its problems; a saved
  lens shows its exact size and how much of it is downloaded.

## Running it

- **Ports.** The server listens on `8080` in the container, published on the host at
  `CATALOG_UI_BIND:CATALOG_UI_PORT`. `3000` serves `GET /health` for the container healthcheck and is
  not published.
- **Access.** Whoever reaches the page acts with `CATALOG_TOKEN` on every forwarded route: starting and
  pausing surveys, and creating, editing and deleting lenses.

## Environment

| variable | default | |
|---|---|---|
| `CATALOG_API` | `http://catalog:8080` | where the catalog answers. A trailing `/` is dropped; blank means the default |
| `PROSPECTOR_API` | `http://prospector:8080` | where prospector's collector API answers. A trailing `/` is dropped; blank means the default |
| `CATALOG_TOKEN` | empty | the secret the catalog and prospector both check, added as `x-catalog-token` to every forwarded request. Empty forwards without the header |
| `CATALOG_UI_HOSTS` | empty: any `Host` | comma-separated `Host` names (or `host:port`) the API routes answer for, set in the archives module's `.env`. Empty serves any `Host` |
| `CATALOG_UI_PORT` | `9020` | host port, set in the archives module's `.env` |
| `CATALOG_UI_BIND` | `127.0.0.1` | host address the port is published on, set in the archives module's `.env` |
| `LOG_LEVEL` | `info` | log level |
| `APP_ENV` | `prod` | which image is built (`docker/<APP_ENV>.node.Dockerfile`), passed to the process as `NODE_ENV` |
| `TZ` | `UTC` | the process's time zone |

## Development

```sh
pnpm --filter @tradebot/catalog-ui build   # tsc -p web && vite build && tsc -b
pnpm --filter @tradebot/catalog-ui start   # the built server, on :8080
pnpm --filter @tradebot/catalog-ui dev     # Vite, proxying /api to :8080
pnpm --filter @tradebot/catalog-ui test
```

`dev` serves the page with Vite and proxies `/api` to a catalog-ui server on `localhost:8080`, which
you start yourself after a build, e.g.
`CATALOG_API=http://localhost:<catalog port> pnpm --filter @tradebot/catalog-ui start`. Add
`PROSPECTOR_API=http://localhost:<prospector port>` for the Surveys tab to reach prospector; without it
the server asks `http://prospector:8080`, and the tab answers `502` unless that name resolves where the
server runs.

`web/` is the page, built into `dist/web`; `src/` is the server that serves it and forwards `/api`.
