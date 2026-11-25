# ui (stub)

A trading dashboard layout in React 19 and Vite, kept as a stub. It has no data source: the market-data
widgets say so, and the account widgets show static sample data.

Deployed by: no module.

For the intended design of a replay-capable UI, see [docs/planning/UI.md](../../../docs/planning/UI.md).

## What exists

**Routing.** One route, `/:symbol` (the contract shown); `/` redirects to `/XBTUSD`.

**Shell.** A header with the application's name above the widget grid.

**Widgets** (`src/widgets/`), on a `react-grid-layout` grid of 12 columns and 12 rows that fill the
container's height, dragged by their header and resized from the corner. The layout is kept in
`localStorage` under `tradebot.ui.layout` and falls back to the default when the stored value is
missing or not a layout.

| Widget | Shows |
|---|---|
| Chart | The route's symbol in its title, and "No data source configured" |
| Orderbook, Recent trades | "No data source configured" |
| Positions, Orders, Order history, Trade history, Margin | Static sample data from `src/data/mockData.ts` |
| Depth chart | A placeholder |

## Variables

| Variable | Read by | Default | Meaning |
|---|---|---|---|
| `UI_BIND` | `docker/compose.yml` | `127.0.0.1` | Host address the dev server's port is published on |
| `UI_PORT` | `docker/compose.yml` | `3000` | Host port published for the dev server |

The dev server listens on port 3000 on all interfaces.

## Running

```sh
pnpm --filter @tradebot/ui dev                            # dev server on :3000
pnpm --filter @tradebot/ui test                           # vitest
docker compose -f services/_stub/ui/docker/compose.yml up  # the same dev server in the dev image
```

The compose file builds `docker/dev.node.Dockerfile`, mounts the repository at `/live`, and runs
`pnpm install --ignore-scripts && pnpm dev` in `services/_stub/ui`. It joins no shared network.
