# UI: a replay-capable interface

The intended design of a UI for watching and training trading bots. It is not a trading terminal. The
stub as it stands is described in its own [README](../../services/_stub/ui/README.md).

The UI has two jobs:

1. **Show live market data**: chart, order book, recent trades, positions, orders and wallet. This is the
   view a trader would use, with the bot as the one acting on it.
2. **Replay history**: move through the collected history at any speed and watch market data and the
   bot's actions unfold as if they were live.

The design is built around the second job. A choice that makes replay awkward is the wrong choice.

## Time

Time is not a clock that only moves forward. The data layer supports three modes, and a jump:

- **Live**: data comes from the venue in real time, and time moves at 1×.
- **Replay**: history comes from a replay backend at a chosen speed, from well below 1× to 100× and
  beyond.
- **Paused**: time stops, and every widget holds its last state.
- **Seeking**: time jumps to any timestamp, and every widget resets and rebuilds from there.

The replay backend is the replay engine in [ROADMAP.md](ROADMAP.md#part-5--the-replay-engine).

## The replay switch

Moving from live to replay is a configuration change in one place, the data layer. No widget is
rewritten for it. Everything below exists to keep it that way.

## Widgets are pure consumers

A widget calls a hook, gets data and renders it. A widget never:

- opens or closes a connection;
- knows whether its data is live or replayed;
- handles reconnection or buffering;
- manages the lifecycle of its own subscriptions;
- has an effect that touches a socket, a REST endpoint or a subscription;
- takes data through props. Props carry configuration only, such as a depth limit or a timeframe.

Connections, subscriptions, reconnection, buffering and the live or replay source all belong to the
data layer. Widgets reach it only through hooks.

## Hooks and channels

A **channel** is a named stream of typed messages. `useChannel<T>(name)` returns the channel's current
state: an array for a table (trades, orders), or a single object for a singleton. How that state was
produced, which venue sent it and whether it is live or replayed, is the data layer's business.

Two kinds of data need more than a plain channel. Their hooks keep the same shape whatever the source:

- **Order book.** A venue sends a snapshot and then deltas (insert, update, delete). The data layer
  folds them into a full book in one place. `useOrderbook()` returns `{ asks, bids }`, sorted and cut
  to the depth the widget asks for.
- **Candles.** History comes from a request, and new bars come from a live stream as they close.
  `useCandles(symbol, timeframe, { from, to })` does both: it fetches the range when it mounts or when
  the range changes, appends each bar that closes, and has `loadMore(earlierFrom)`, which prepends
  earlier bars without fetching the visible range again.

## Time control

A provider wraps the app and exposes:

```ts
{
  mode: 'live' | 'replay' | 'paused',
  speed: number,          // replay multiplier
  currentTime: Date,      // time of the current data frame
  play(): void,
  pause(): void,
  setSpeed(n: number): void,
  seek(timestamp: Date): void,
}
```

Every channel follows `currentTime`. On a seek, each channel drops its state and asks the replay
backend for a snapshot at the new timestamp. The data layer drives this, and widgets see only the new
data.
