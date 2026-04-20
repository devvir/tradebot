# UI Service — Technical Reference

## Purpose

The UI is a monitoring and training interface for trading bots, not a trading terminal. Its two jobs are:

1. **Visualize live market data** — chart, orderbook, recent trades, positions, orders, wallet — the same view a trader would use, but consumed by bots.
2. **Replay history** — scroll through the collected dataset (2014 to present) at any speed, watching market data and bot actions unfold as if it were live.

Everything is built around the second job. Any decision that would make replay awkward is wrong.

## The Time Machine Model

Time in this UI is not a fixed forward-moving clock. The data layer must support:

- **Live mode** — real-time data from a WebSocket server, time moves forward at 1×.
- **Replay mode** — historical data served by a replay backend, time moves at configurable speed (0.1× to 100× or faster).
- **Paused** — time stops; widgets hold their last state.
- **Scrubbing** — jumping to an arbitrary timestamp; widgets reset and rebuild from that point.

The replay backend is a future backend service. The UI's data layer must be designed so that switching from live to replay is a configuration change at one place, not a rewrite of every widget.

## Separation of Concerns — The Cardinal Rule

**Widgets are pure consumers.** A widget calls a hook, gets data, renders it. Full stop.

```
Widget                     Data Layer
──────                     ──────────
useChannel('trade')   →    manages connection, reconnects, replay
useChannel('orderBook') →  manages snapshot + delta accumulation
useCandles(...)       →    manages REST fetch, pagination, live updates
```

No widget ever:
- Opens or closes a WebSocket.
- Knows whether data is live or replayed.
- Handles reconnection or buffering.
- Manages its own subscription lifecycle.

Violating this makes the replay feature impossible to build without rewriting every widget. Good abstractions here are not optional.

## Data Layer Architecture

The data layer lives entirely in `src/data/`. Widgets import only from hooks in `src/hooks/`.

```
src/
  data/
    DataProvider.tsx     — React context, owns the connection/source
    client/
      LiveClient.ts      — WebSocket client for live mode
      ReplayClient.ts    — client for the replay backend (future)
    channels/
      trade.ts           — shapes incoming trade messages
      orderBook.ts       — accumulates deltas into a snapshot
      instrument.ts      — tracks contract stats
      order.ts           — active orders channel
      position.ts        — position channel
      execution.ts       — fill/execution channel
  hooks/
    useChannel.ts        — generic: useChannel<T>(name) → T[]
    useOrderbook.ts      — orderbook-specific: returns { asks, bids }
    useCandles.ts        — chart-specific: fetch + live subscription combined
    useTimeControl.ts    — exposes play/pause/speed/scrub controls
```

### Channel contract

A channel is a named stream of typed messages. The shape of each channel matches the BitMEX WebSocket channel of the same name. Types live in `shared/types`.

`useChannel<T>(channelName)` returns the current state for that channel — an array for tables (trade, orderBook rows, orders), a single object for singletons. The widget does not care how that state was produced.

### Orderbook

The orderbook is not a simple channel. BitMEX sends a snapshot on subscribe then delta updates (insert/update/delete). The `orderBook` channel handler accumulates these into a full in-memory snapshot and exposes `{ asks, bids }` sorted and sliced to the depth the widget needs. The widget calls `useOrderbook()` and renders. The accumulation logic lives once, in `channels/orderBook.ts`.

### Chart / Candles

Candles are not a WebSocket channel — they require a REST fetch for historical bars and a live subscription for new bars as they close. `useCandles(symbol, timeframe, { from, to })` handles both:

1. On mount (or when the range changes), fetch historical candles from the backend REST API.
2. Subscribe to the live `tradeBin{timeframe}` channel and append new bars as they arrive.
3. When the user scrolls the chart sideways to request earlier data, call `loadMore(earlierFrom)` — the hook fetches and prepends without re-fetching the visible range.

This interface is fixed regardless of whether the data comes from the live BitMEX API or a replay backend. The hook's internals swap; the widget does not change.

### Time control

A `TimeControlProvider` wraps the app and exposes:

```ts
{
  mode: 'live' | 'replay' | 'paused',
  speed: number,          // replay multiplier
  currentTime: Date,      // wall time of the current data frame
  play(): void,
  pause(): void,
  setSpeed(n: number): void,
  seek(timestamp: Date): void,
}
```

All channel handlers subscribe to `currentTime` changes. On a seek, they flush their state and request a new snapshot from the replay backend at that timestamp. The `DataProvider` drives this; widgets are oblivious.

## Widget Contract

A widget is a React component that:

- Calls one or more hooks from `src/hooks/` to get data.
- Renders that data.
- Has no `useEffect` that touches a socket, REST endpoint, or subscription.
- Accepts no data via props — props are for configuration only (e.g. depth limit, timeframe).

Every widget uses the `.widget` / `.widget__header` / `.widget__body` shell defined in `bitmex.css`. The header is the drag handle for `react-grid-layout`.

## Layout

Widgets are arranged with `react-grid-layout` (v2). The grid is 12 columns wide; row height is computed dynamically from the container height so the initial layout fills the viewport. Layout is persisted to `localStorage` so positions survive page reload.

`WidgetGrid.tsx` owns the layout state and the `localStorage` sync. It renders the grid shell; individual widgets are unaware of their position or size.

## Current State (as of April 2026)

All widgets exist as shells consuming mock data from `src/data/mockData.ts`. The data layer, hooks, and providers do not exist yet — they are the next major phase.

Mock data is intentionally isolated in `mockData.ts` so that replacing it with real hooks is a one-file-per-widget change when the data layer is ready.

## Build

Vite SPA, no SSR. `VITE_*` env vars are baked at build time. The service is containerized using the shared `docker/dev.node.Dockerfile`; the module `modules/gui/bitmex` wires it into a runnable compose stack.
