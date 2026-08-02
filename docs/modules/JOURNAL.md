# Journal Module

Live WebSocket capture for BitMEX: every message the socket delivers, recorded to the vault
service as it arrives. The bulk and REST counterpart is [depot](DEPOT.md).

```
BitMEX WebSocket  →  broadcast  →  exchange:broadcast
                                         ↓  (pipe: topic:broadcast > topic:journalist)
                                  exchange:journalist  →  journalist  →  vault service
```

This module is **BitMEX-only by construction** — broadcast speaks BitMEX's subscription protocol
and journalist knows BitMEX's table semantics — and it stays that way. Live capture for every
other venue belongs to `hoarder`, which collects any number of them through one interface and
publishes verbatim.

The split is deliberate rather than transitional: journal already works, and porting a closing
venue onto newer machinery would spend effort on a path with a known end date. Journal runs
until BitMEX's market does, because a realtime stream missed is unrecoverable; after that the
history it captured stays, and nothing new arrives.

## Why capture live at all

Almost everything here is available from bulk files or REST, and those sources are preferred
wherever they overlap — they hand over years at once and survive an outage. What a live socket
supplies that neither can is event-level sequencing, sub-second timing, and the fields an
archive never carries. That is the whole justification, and it is why WebSocket collection is
scoped to the gap rather than pointed at everything.

## Services

### broadcast

Connects to the BitMEX WebSocket API and publishes every message to the `broadcast` topic
exchange with routing key `{table}.{action}` (e.g. `trade.insert`, `orderBookL2.update`).
Subscriptions come from `BROADCAST_FEED_PRESET` (which channels) and `BROADCAST_POOLS` (which
liquidity pools), or from the commands API at runtime.

With `BROADCAST_POOLS=primary,secondary,aggregated` the same table arrives once per pool, each
row self-labelled by its `pool` field — which is how pools are recorded side by side for
comparison. → [services/BROADCAST.md](../services/BROADCAST.md)

### journalist

Consumes everything from the `journalist` exchange, augments each entry with its `action`,
buffers per table, and writes date-partitioned files to the vault service. Closes the previous
day's file when a new date appears in the stream.

Three BitMEX tables carry no datetime field (`connected`, `liquidation`,
`publicNotifications`). Journalist injects a synthetic `ts` derived from the stream clock of the
other tables, so a replay engine can serve them in time-sync with the rest.
→ [services/JOURNALIST.md](../services/JOURNALIST.md)

### pipe

A one-shot service that declares the `broadcast → journalist` exchange-to-exchange binding in
RabbitMQ (`topic:broadcast > topic:journalist`, routing key `#`) and exits. Runs with
`restart: on-failure` so it retries until the broker is ready.

The indirection is what keeps broadcast a pure relay: it publishes once, and any number of
consumers bind to it without broadcast knowing they exist.

### vault

The same HTTP file store depot writes to — one sealed gzip CSV per `(table, date)`.
→ [services/VAULT.md](../services/VAULT.md)

## What lands on disk

Journalist writes into the same vault layout as courier and scribe, so a consumer reads one
tree regardless of which source filled it:

```
/data/vault/
  trade/2026/20260101.csv.gz   ← closed (complete day)
  trade/2026/20260329.csv      ← open (today, being written)
  orderBookL2/…
  instrument/…
```

Each row carries all original BitMEX fields plus:

- `action` — the WS message action (`partial` / `insert` / `update` / `delete`)
- `ts` — synthetic stream timestamp, only on rows from the three timeless tables

Message boundaries survive the round trip: vault keeps the rows of one WS message together, and
its NDJSON read path emits one line per original message — `{ action, date, data: [...] }`. A
replay engine needs that grouping to reproduce the stream frame for frame.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `BROADCAST_FEED_PRESET` | `none` | Channel preset to subscribe on startup |
| `BROADCAST_POOLS` | `default` | Liquidity pools to collect (`default,primary,secondary,aggregated`) — see [BROADCAST.md](../services/BROADCAST.md#pool-filtering-broadcast_pools) |

## Running it

```bash
tb up journal
```
