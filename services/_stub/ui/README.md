# ui (stub)

A BitMEX-style trading dashboard in React 19 and Vite, kept as a stub. It is wired against BitMEX's REST
and WebSocket APIs and against `digger`, a replay backend that no service in this repository provides.

Deployed by: no module.

For the intended design of a replay-capable UI, see [docs/planning/UI.md](../../../docs/planning/UI.md).

## What exists

**Routing.** One route, `/:symbol` (the contract shown); `/` redirects to `/XBTUSD`.

**Environments.** A dropdown in the header picks `live`, `testnet` or `replay`. `EnvProvider` holds the
choice and keeps it in `localStorage` under `tradebot.ui.env`; a stored value that is unknown, or
`replay` in a build without replay, restores as `live`. The wiring per environment is in
`src/data/envs.ts`:

| Env | REST | WebSocket |
|---|---|---|
| `live` | `/api/v1` (proxied) | `wss://ws.bitmex.com/realtime` |
| `testnet` | `/api/v1` (proxied), with header `x-testnet: true` | `wss://ws.testnet.bitmex.com/realtime` |
| `replay` | `/replay` (proxied) | `/replay-ws/realtime` (proxied), plus control at `/replay-control` |

**Data layer** (`src/data/`). `App.tsx` mounts `DataProvider` with `key={env}`, so switching
environment unmounts the data layer and every widget and rebuilds them against the new one.
`DataProvider` gives widgets:

- `useBitmex()`: a `BitmexClient`, whose `fetch(table, count, params)` reads one REST page newest first,
  and whose `stream(table, handler)` subscribes to a WebSocket table and returns its unsubscribe.
  Streaming goes through `WsClient`: one connection per client, ref-counted subscriptions per channel
  (the unsubscribe is sent when a channel's last listener leaves), and reconnects with a backoff from 1 s
  doubling to 30 s, resubscribing every channel.
- `useDigger()`: a `DiggerClient` in `replay` when the build has replay on, else `null`. Its one call,
  `setClock(timestamp)`, posts `<control>/set-clock?timestamp=<epoch ms>`; the header shows a replay clock
  picker that calls it.

**Widgets** (`src/widgets/`), on a `react-grid-layout` grid of 12 columns and 12 rows that fill the
container's height, dragged by their header and resized from the corner. The layout is kept in
`localStorage` under `bitmex-widget-layout` and falls back to the default when the stored value is
missing or not a layout.

| Widget | Data |
|---|---|
| Chart | `useChart`: `useChartViewport` (zoom and pan) over `useChartCandles`, which joins `useClosedCandles` (REST `trade/bucketed`, WS `tradeBin1m`/`5m`/`1h`/`1d:<symbol>`) and `useRunningCandle` (the open bin, built from WS `trade:<symbol>`) |
| Orderbook | `useOrderbook`: WS `orderBookL2_25:<symbol>` |
| Recent trades | `useRecentTrades`: one REST `trade` page plus WS `trade:<symbol>` |
| Positions, Orders, Order history, Trade history, Margin | Static data from `src/data/mockData.ts` |
| Depth chart | A placeholder |

The order-entry sidebar, the contract bar and the footer show static values.

## Variables

| Variable | Read by | Default | Meaning |
|---|---|---|---|
| `UI_PORT` | `docker/compose.yml` | `3000` | Host port published for the dev server (on every host address) |
| `UI_REST_PROXY` | `vite.config.ts`, passed by compose | `http://proxy` | Target of `/api/v1/*`, headers included |
| `UI_DIGGER_HOST` | `vite.config.ts`, passed by compose | empty | Replay backend host. Set, the dev server proxies `/replay`, `/replay-ws` and `/replay-control` to it and the build has replay on; empty, the Replay option is disabled |
| `UI_DIGGER_REST_PORT` | `vite.config.ts` | `3101` | Target port of `/replay`, rewritten to `/api/v1` |
| `UI_DIGGER_WS_PORT` | `vite.config.ts` | `8180` | Target port of `/replay-ws` (WebSocket), prefix stripped |
| `UI_DIGGER_CONTROL_PORT` | `vite.config.ts` | `8280` | Target port of `/replay-control`, prefix stripped |

The dev server listens on port 3000 on all interfaces. Compose does not pass the three `UI_DIGGER_*_PORT`
variables, so in the container they keep their defaults.

## Running

```sh
pnpm --filter @tradebot/ui dev                            # dev server on :3000
pnpm --filter @tradebot/ui test                           # vitest
docker compose -f services/_stub/ui/docker/compose.yml up  # the same dev server in the dev image
```

The compose file builds `docker/dev.node.Dockerfile`, mounts the repository at `/live`, and runs
`pnpm install --ignore-scripts && pnpm dev` in `services/_stub/ui`. It joins no shared network.
