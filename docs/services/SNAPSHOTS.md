# Snapshots Service - Technical Documentation

## Overview

The Snapshots service maintains real-time per-table state by consuming delta messages from BitMEX-format data streams. It exposes the current state via HTTP, enabling clients to bootstrap with consistent snapshots and coordinate ordering with subsequent delta updates.

## Architecture

### Data Flow

```
RabbitMQ snapshots queue
    ├─ routing key: {table}.{action}
    └─ headers:
        │ x-message-count         — counter tracking message sequence (increments per publish)
         ↓
 Snapshots Service (in-memory)
    ├─ accumulator: applies deltas to per-table snapshot
    └─ http server on :80
         ↓
 GET /snapshot/{table}
    ├─ status 200: { table, action: "partial", data, keys, counter, ... }
    └─ status 404: { error: "No snapshot for table '..'" }
```

### Message Accumulation

The service consumes RabbitMQ messages with the following action types (BitMEX WebSocket protocol):

| Action | Behavior |
|--------|----------|
| `partial` | Replace entire table (creates or resets snapshot) |
| `insert`  | Append rows to snapshot |
| `update`  | Merge rows by their key fields; non-existent rows are skipped |
| `delete`  | Remove rows by their key fields |

Each incoming delta updates the table state in-memory. After applying the delta, the snapshot's `counter` is set to the `x-message-counter` header from the message.

### Message Headers

Incoming RabbitMQ messages may include a header that coordinates ordering across the system:

- **`x-message-count`** — Incremental counter from the originating service (e.g. reader or broadcast)
  - If present: normal operation, use counter in the table snapshot
  - If missing: set to zero (signals downstream that we do not have a counter to ensure ordering)

## State Model

In-memory state is keyed by table name only (no symbol separation). A table's state is an object:

```typescript
interface Snapshot {
  conter:       number;                           // counter from last message applied
  action:       'partial';                        // literal type, constant
  keys:         string[];                         // column names (from partial)
  types:        Record<string, BitmexFieldType>;  // column types (from partial, optional)
  data:         BitmexDataItem[];                 // data array (tuples by column order)
  foreignKeys?: Record<string, string>;           // metadata (if present in partial)
  attributes?:  Record<string, string>;           // metadata (if present in partial)
  filter?:      Record<string, unknown>;          // metadata (if present in partial)
}
```

On a `partial` action, all fields are replaced. On `insert`/`update`/`delete`, only the `data` changes. Keys and types are immutable until the next `partial`.

## HTTP Server

Listens on port `3001`. Only GET requests to `/snapshot/{table}` are supported. An optional querystring filter `symbol` is accepted (filters data items by their symbol property).

### Endpoint: GET `/snapshot/{table}`

**Response (200 OK):**
```json
{
  "table": "orderBookL2",
  "action": "partial",
  "keys": ["symbol", "id", "side", "size", "price"],
  "types": { "symbol": "string", "id": "long", ... },
  "data": [["XBTUSD", 1, "Buy", 100, 20000], ...],
  "counter": 42,
}
```

**Response (404 Not Found):**
```json
{
  "error": "No snapshot for table 'nonexistent'"
}
```

The `keys` and `types` fields describe the column schema. The `data` field contains rows as arrays (tuples), indexed by column position.

## RabbitMQ Queue

The service declares:
- **Queue:** `snapshots` (durable, non-exclusive, on the default exchange)

The queue name `snapshots` is provided via the `service.declare({ ... })` declaration. The service consumes and acknowledges messages individually (auto-ack disabled for safety).

## Configuration

Requires RabbitMQ — see [infra packs](../../modules/infra/README.md).

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SNAPSHOTS_PORT` | no | <empty> | HTTP server host port |

## Lifecycle

1. **On start** — Service connects to RabbitMQ and begins consuming from the `snapshots` queue
2. **On message** — Create/update table snapshot (action=partial) or apply delta (insert/update/delete)
3. **On client request** — Serve current state or 404
4. **On shutdown** — Close RabbitMQ consumer and HTTP server cleanly

No persistence layer (Redis or database) — snapshots exist only in RAM for the lifetime of the service. On restart, the service is empty until partials arrive.

## Dependencies

### External Service
- **RabbitMQ** — For consuming delta messages from the `snapshots` queue. See [infra packs](../../modules/infra/README.md).

### NPM Packages
- `@devvir/service-kit` — Service lifecycle and RabbitMQ broker
- `@tradebot/utils` — Shared utilities (logger)

## Typical Integration: Live Exchange Module

The `modules/exchange/live` module uses snapshots:

1. **Router** binds `snapshots.*.*` from `broadcast` → snapshot service's queue
2. **WS service** (on client subscribe):
   - Fetches snapshot from `http://snapshots/snapshot/{table}`
   - Buffers deltas from RabbitMQ
   - Serves snapshot on subscription
   - Streams subsequent deltas to connected clients

This pull model (vs. RabbitMQ push) avoids redundant snapshot publishing and reduces memory pressure.

## Error Handling

### Connection Failures
- **RabbitMQ disconnect** — Service logs and waits for broker reconnection (handled by service-kit)
- **HTTP request to closed service** — Returns connection refused (expected client-side retry)

### Data Issues
- **Malformed message** — Logged as error, message skipped, consumption continues
- **Snapshot for nonexistent table** — Returns 404 (correct — no state yet)

### Graceful Shutdown

On SIGTERM/SIGINT, the service:
1. Stops accepting new messages from RabbitMQ
2. Closes the HTTP server (rejecting new requests)
3. Exits, releasing all in-memory state

See [service-kit: graceful shutdown](../../packages/service-kit/docs/guides/graceful-shutdown.md).
