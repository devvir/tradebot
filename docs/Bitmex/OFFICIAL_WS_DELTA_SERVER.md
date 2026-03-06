# BitMEX Delta Server — Full Summary

A thin Express HTTP server that wraps the `bitmex-realtime-api` nodejs client and exposes the current in-memory market state as REST endpoints.
Source: `../../../api-connectors/official-ws/delta-server/`

---

## What it does

1. Connects to BitMEX WS using the nodejs client (see `OFFICIAL_WS_NODEJS.md`)
2. Subscribes to a configured list of symbols × streams
3. Accumulates deltas into in-memory state (handled by the nodejs client's deltaParser)
4. Exposes HTTP endpoints that return the current snapshot on demand

It is a polling server — consumers call it when they want current data, rather than receiving a push stream.

---

## Architecture

```
BitMEX WS → nodejs client (delta accumulation) → Express HTTP server → polling consumers
```

No authentication layer. Intended for internal/local use only.

### Endpoints

| Route | Description |
|---|---|
| `GET /` | HTML index listing configured tables and symbols |
| `GET /:stream` | Current snapshot for all subscribed symbols of a stream |
| `GET /:stream?symbol=XBTUSD` | Current snapshot for a specific symbol |

Data is returned via `client.getData(symbol, stream)`, which is a deep clone of the internal store — safe to modify.

### Config (`config.example.js` → copy to `config.js`)

| Field | Default | Notes |
|---|---|---|
| `port` | 4444 | Also via CLI arg 1 or `PORT` env |
| `testnet` | true | false for production |
| `symbols` | `['XBTUSD']` | Instruments to watch |
| `streams` | `["instrument","orderBookL2","quote","trade"]` | Tables to subscribe to |
| `apiKeyID/Secret` | empty | Required only for private streams |
| `maxTableLen` | 10000 | FIFO cap on rows per table/symbol to limit memory |

### Error handling

- Logs WebSocket errors via `console.error`
- Calls `process.exit(1)` on the `end` event (unrecoverable WS error — e.g. 401 or clean 1000 close), which Docker will restart

---

## Relevance to tradebot

**Not directly useful as-is.** The delta server is a polling tool for simple consumers — it's the opposite architecture from what tradebot needs (push, not pull).

However, it is a useful reference for two things:

### 1. The local WS clone server is the same idea, inverted

The delta server:
- Consumes from BitMEX WS → accumulates state → serves HTTP snapshots

The tradebot replay server needs to:
- Consume from MongoDB (stored deltas) → accumulate state → serve WS streams

The delta-accumulation step is identical. The `deltaParser` from the nodejs client is the right tool for building the `partial` snapshot that must be sent to each new subscriber on the replay server.

### 2. It shows what "current state" means for each table

The delta server demonstrates that for all tables, the latest state is just the result of replaying all deltas since the last `partial`. There is no special handling needed per-table for snapshot building — it's the same `partial/insert/update/delete` logic for all of them.

---

## What the replay server needs that the delta server doesn't provide

The delta server only provides snapshots on demand. The replay server must additionally:

- Accept WebSocket connections and speak the BitMEX WS protocol
- Handle `{op: "subscribe", args: [...]}` from connecting clients
- Send a `partial` for each subscribed table/symbol on subscription (built from stored deltas)
- Stream subsequent deltas in timestamp order
- Support pacing modes: real-time (original timestamps), accelerated (max throughput), live (forward from broadcast)
- For accelerated mode: flow control / backpressure so fast producers don't overwhelm slow consumers
