# Journal Module — Technical Reference

## Overview

```
BitMEX WebSocket  →  broadcast  →  exchange:broadcast
                                         ↓  (pipe: topic:broadcast > topic:journalist)
                                  exchange:journalist  →  journalist  →  vault
```

Journal records live BitMEX WebSocket events to vault. It is the real-time counterpart to depot (which accumulates historical data). Both write to the same vault storage layout.

## Services

### vault

HTTP service that owns raw data file storage. Accepts JSON rows (serialised to CSV internally). Each `(table, date)` pair becomes one gzip file once closed. See [depot docs](DEPOT.md#vault) for the full API reference.

### broadcast

Connects to the BitMEX WebSocket API and publishes every message to the `broadcast` topic exchange with routing key `{table}.{action}` (e.g. `trade.insert`, `orderBookL2.update`). Subscriptions are configured via `BROADCAST_FEED_PRESET` or the commands API at runtime.

### journalist

Consumes all messages from the `journalist` exchange, augments each entry with `action`, buffers them per table, and writes them to vault as date-partitioned files. Closes the previous day's file when a new date appears in the stream.

Three BitMEX tables carry no datetime field (`connected`, `liquidation`, `publicNotifications`). Journalist injects a synthetic `ts` field into their entries using the stream clock derived from other tables, so a replay engine can serve them in time-sync with the rest of the stream. See [JOURNALIST.md](../services/JOURNALIST.md) for the full buffering and flushing algorithm.

### pipe (journal-pipe)

A one-shot service that declares the exchange-to-exchange binding `broadcast → journalist` in RabbitMQ, then exits. Runs with `restart: on-failure` so it retries if the broker isn't ready yet.

Binding: `topic:broadcast > topic:journalist` (routing key `#` — all messages).

## Data Layout

Journalist writes to the same vault directory structure as scribe and courier:

```
/data/vault/
  trade/
    2026/20260101.csv.gz   ← closed (complete day)
    2026/20260329.csv      ← open (today, being written)
  orderBookL2/
    ...
  quote/
    ...
  instrument/
    ...
```

Each row in a file contains all original BitMEX fields plus:
- `action` — the WS message action (`partial` / `insert` / `update` / `delete`)
- `ts` — synthetic stream timestamp, present only on rows from timeless tables (`connected`, `liquidation`, `publicNotifications`)

## Configuration

| Variable                | Default              | Purpose                                                   |
|-------------------------|----------------------|-----------------------------------------------------------|
| `BROADCAST_FEED_PRESET` | `none`               | Channel preset to subscribe on startup                    |
