# Catalog UI

A browser for what the catalog holds, and the controls to survey it.

It stores nothing, decides nothing and surveys nothing. Every answer comes from
prospector's own API and is rendered unchanged — which is the point of it: a
question this cannot answer is a question the API cannot answer, and that is the
cheapest way to find out.

```
http://localhost:9020
```

Architecture, the proxy and what every column means are in
[CATALOG-UI.md](../../docs/services/CATALOG-UI.md).

## What it shows

- **contents** — venues, then a venue's markets, then one row per
  `(dataset, variant, grain)` that market publishes. Symbol lists at venue and
  market level, asked for rather than loaded.
- **surveys** — what every venue is doing, polled every ten seconds, with
  Start/Pause/Resume, Update and Refresh per venue, and the same across all of
  them.

## Environment

| variable | | |
|---|---|---|
| `CATALOG_URL` | `http://prospector:8080` | where the catalog answers |
| `CATALOG_TOKEN` | — | its secret. Empty means the catalog is open; this forwards without a header |
| `HAULER_URL` | — | where hauler answers, for the shopping list. Empty means there is none, and the page says so |
| `CATALOG_UI_PORT` | `9020` | host port, set in the catalog module's `.env` |

## Development

```sh
pnpm --filter @tradebot/catalog-ui build   # vite build && tsc -b
pnpm --filter @tradebot/catalog-ui dev     # vite, proxying /api to :8080
```

`web/` is the page, built into `dist/web`; `src/` is the server that serves it
and forwards `/api`.
