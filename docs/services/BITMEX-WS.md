# Bitmex-WS Service

## Overview

The Bitmex-WS service is a WebSocket server that provides a real-time market data streaming interface compatible with BitMEX's official WebSocket API. Clients connect and subscribe to data channels (e.g., `orderBookL2:XBTUSD`, `trade:ETHUSD`), receive an initial snapshot of the subscribed data, and then receive real-time delta and message updates as they occur. The service is a transparent replacement for BitMEX's official WebSocket endpoint.

The service acts as a **subscription and delivery layer**: it consumes snapshots from the Snapshots service and raw deltas from the Feed service via RabbitMQ, maintains in-memory snapshots for each market state, and broadcasts updates to subscribed clients in real-time. Clients experience the same API and message format as if connected directly to BitMEX, but data is sourced from the internal Feed and Snapshots services.

## Extended Definition

### What It Does

The Bitmex-WS service provides a self-contained WebSocket streaming capability:

1. **Runs a WebSocket Server**
   - Listens on a configurable port (default: 8080)
   - Accepts client connections and establishes persistent WebSocket sessions
   - Handles WebSocket connection lifecycle: open, message, close, error events
   - Implements WebSocket keep-alive (ping/pong) to maintain client connections

2. **Manages Client Subscriptions**
   - Receives subscription messages from clients (format: `subscribe`, `unsubscribe`, `cancel-subscription`)
   - Maintains per-client subscription state (set of channels this client is subscribed to)
   - Supports partial subscriptions (client can subscribe to `orderBookL2:*` to get all symbols, or specific `orderBookL2:XBTUSD`)
   - Broadcasts updates only to clients subscribed to that channel/symbol

3. **Maintains Snapshot State**
   - Consumes from `bitmex-snapshots` exchange (topic: `snapshot:#`) and stores the latest snapshot for each market (keyed by `channel:symbol`)
   - Replaces older snapshots with newer ones (by comparing version IDs or timestamps)
   - Index allows fast lookups: when a client subscribes to `orderBookL2:XBTUSD`, retrieve the latest snapshot in microseconds

4. **Serves Initial Snapshots on Connection**
   - When a client subscribes, immediately sends the current snapshot (if available) before sending any deltas
   - Snapshots are sent with action `snapshot` to match BitMEX API behavior
   - If no snapshot exists yet (e.g., early connection, no data received), wait (configurable timeout) or send empty/partial snapshot

5. **Streams Real-Time Updates**
   - Consumes from `bitmex-data` exchange (topic: `#`) to receive raw deltas and atomic messages from the Feed
   - For subscribed clients, broadcasts messages as they arrive in near-real-time (latency in tens of milliseconds, subject to message queue latency)
   - Messages are sent with action `update`, `partial`, `insert`, `delete` to match BitMEX message format
   - Routing ensures messages go only to clients subscribed to that channel/symbol

6. **Broadcasts Atomic Messages**
   - For non-delta channels (e.g., `trade`), send each message to subscribed clients as-is
   - Trade messages, liquidation events, funding payouts are forwarded without modification
   - Clients receive the same atomic message atomicity as with BitMEX

7. **Provides Observability**
   - Exposes a health check endpoint reporting server status and client count
   - Logs client connections, subscriptions, and errors
   - Tracks metrics: active client count, messages sent, spectator subscriptions

### Design Philosophy

The Bitmex-WS embodies these principles:

- **API compatibility**: Clients connecting to this service should experience the same API, message format, and behavior as BitMEX's WebSocket API. This enables drop-in replacement or seamless switching.
- **Stateful delivery**: The service maintains snapshots and client subscriptions, decoupling rapid market updates from slow client consumption.
- **Fire-and-forget publishing**: Once a message is sent to a client, the service doesn't track or retry. If a client disconnects mid-message, the message is lost (matching WebSocket behavior).
- **Isolation from upstream**: The service doesn't depend on Feed or Snapshots implementation details. Changes to those services are transparent as long as the RabbitMQ exchange contracts remain stable.
- **Scalability via partitioning**: Multiple Bitmex-WS instances can run independently, each consuming the same RabbitMQ exchanges. Clients can load-balance or failover between instances transparently.

### Message Format & Flow

#### Client Subscription

Clients send subscription messages to the server:

```json
{
  "op": "subscribe",
  "args": ["orderBookL2:XBTUSD", "trade:ETHUSD", "quote:*"]
}
```

**Server response:**
- Confirms subscription (sends a subscription confirmation message)
- Fetches and sends the initial snapshot for each subscribed channel
- Begins forwarding live updates to the client

#### Server-to-Client Messages

**Snapshot (on subscription):**
```json
{
  "table": "orderBookL2",
  "action": "snapshot",
  "symbol": "XBTUSD",
  "data": [...],
  "timestamp": "2026-02-14T12:34:56.789Z"
}
```

**Delta (real-time update):**
```json
{
  "table": "orderBookL2",
  "action": "update",
  "symbol": "XBTUSD",
  "data": [...],
  "timestamp": "2026-02-14T12:34:57.123Z"
}
```

**Atomic message (e.g., trade):**
```json
{
  "table": "trade",
  "action": "insert",
  "symbol": "XBTUSD",
  "data": [...],
  "timestamp": "2026-02-14T12:34:57.456Z"
}
```

#### Subscription Patterns

Clients subscribe using exact patterns (channel and symbol):
- `orderBookL2:XBTUSD` - specific channel and symbol

**Note:** Wildcard subscriptions (e.g., `orderBookL2:*` for all symbols) are intentionally not supported.
The real BitMEX API does not provide wildcard subscriptions—all subscriptions must be explicit.
This service maintains API fidelity by requiring explicit `channel:symbol` subscriptions only.

**Server routing:** For each incoming market update, the service matches the channel and symbol against all active client subscriptions, and forwards only to matching clients with exact subscription matches.

### In-Memory State

**Snapshot storage:**
```javascript
snapshots = {
  "orderBookL2:XBTUSD": {
    id: "uuid-of-snapshot",
    version: 42,
    data: [...]
  },
  "orderBookL2:ETHUSD": { ... },
  "quote:XBTUSD": { ... },
  // ...
}
```

**Client subscriptions:**
```javascript
clients = {
  "connection-id-1": {
    socket: WebSocketConnection,
    subscriptions: Set(["orderBookL2:XBTUSD", "trade:ETHUSD"]),
    lastSeen: "2026-02-14T12:34:58.000Z"
  },
  // ...
}
```

**Active subscriptions index (for fast broadcast):**
```javascript
subscriptionIndex = {
  "orderBookL2:XBTUSD": Set(["connection-id-1", "connection-id-3"]),
  "trade:ETHUSD": Set(["connection-id-2"]),
  // ...
}
```

This index enables O(1) lookup of all clients subscribed to a channel, making broadcasts efficient.

## Technical Details

### Service Lifecycle

**Startup sequence:**
1. Load configuration from environment (port, RabbitMQ URL, snapshot fetch timeout)
2. Validate configuration (required fields, sensible ranges)
3. Connect to RabbitMQ with retry logic (up to 10 retries, 3-second intervals)
3. Assert exchanges:
   - `bitmex-data` (source of raw deltas)
   - `bitmex-snapshots` (source of aggregated snapshots)
4. Assert/declare queues and bind to exchanges:
   - Queue for snapshots, binding to `bitmex-snapshots` with routing key `snapshot:#`
   - Queue for deltas, binding to `bitmex-data` with routing key `#`
5. Initialize in-memory snapshot store (empty map)
6. Start RabbitMQ consumers (receive snapshots and deltas in separate consumer threads or event handlers)
8. Initialize WebSocket server and start listening on port
9. Initialize health check endpoint
10. Service is now accepting client connections

**Graceful shutdown:**
- On `SIGTERM` or `SIGINT`, set `isShuttingDown` flag
- Stop accepting new client connections
- Send `close` message to all existing clients with reason code (e.g., server restarting)
- Close all client WebSocket connections
- Close RabbitMQ consumers
- Close RabbitMQ connection
- Close WebSocket server
- Exit cleanly

### Core Functions

#### `handleClientConnection(socket)`

Manages the lifecycle of a single client connection.

**Flow:**
1. Assign unique connection ID
2. Add client to global client map
3. Initialize empty subscription set
4. Set up event handlers: message, close, error, ping/pong
5. Send server-ready message to client (e.g., `{"status": "connected"}`)
6. Return (handler is now event-driven)

**Event handlers:**
- `message`: Call `routeClientMessage(socket, message)`
- `close`: Clean up client from map and subscription index
- `error`: Log and close socket
- `ping`/`pong`: Respond to keep-alive frames

#### `routeClientMessage(socket, message)`

Processes incoming client messages.

**Inputs:**
- `socket`: WebSocket connection
- `message`: JSON parsed from client (e.g., `{"op": "subscribe", "args": ["orderBookL2:XBTUSD"]}`)

**Logic:**
1. Parse message and extract `op` field
2. Route based on operation:
   - `subscribe`: Call `handleSubscribe(socket, args)`
   - `unsubscribe`: Call `handleUnsubscribe(socket, args)`
   - `cancel-subscription`: Same as unsubscribe
   - `ping`: Respond with `pong`
   - Others: Log and ignore

**Error handling:**
- Invalid JSON: Send error message to client
- Unknown operation: Send error message and continue
- Subscription errors: Send error message, don't disconnect

#### `handleSubscribe(socket, args)`

Processes subscription requests from a client.

**Inputs:**
- `socket`: WebSocket connection
- `args`: Array of subscription strings (e.g., `["orderBookL2:XBTUSD", "trade:ETHUSD"]`)

**Logic:**
1. For each subscription string in args:
   - Validate format (must match `channel:symbol`, e.g., `orderBookL2:XBTUSD`)
   - Add to client's subscription set
   - Register in subscription index
2. For each subscription, fetch and send current snapshot:
   - Lookup snapshot in in-memory store
   - If exists, send to client with action `snapshot`
   - If not exists, defer delivery (snapshot will be published by Feed and sent when available)
3. Send subscription confirmation to client
4. Future updates matching this subscription will be broadcast to this client

#### `handleUnsubscribe(socket, args)`

Processes unsubscription requests.

**Inputs:**
- `socket`: WebSocket connection
- `args`: Array of subscription strings

**Logic:**
1. For each subscription in args:
   - Remove from client's subscription set
   - Remove from subscription index
2. Send unsubscription confirmation to client
3. Client will no longer receive updates for this subscription

#### `consumeSnapshots(channel)`

Consumes snapshots from `bitmex-snapshots` exchange.

**Flow:**
1. Bind to `bitmex-snapshots` exchange with routing key `snapshot:#`
2. For each received message:
   - Extract `table` (channel), `symbol`, and `data`
   - Lookup current snapshot for `channel:symbol` in store
   - If existing snapshot is older (by version ID or timestamp), replace it
   - If new snapshot is older, discard (out-of-order arrival)
3. Continue consuming until shutdown

**Error handling:**
- Parse errors: Log and skip message
- Store update errors: Log and continue
- Connection errors: Bubble up to trigger reconnection

#### `consumeDeltas(channel)`

Consumes raw deltas and atomic messages from the `bitmex-data` exchange.

**Flow:**
1. Bind to `bitmex-data` exchange with routing key `#` (all topics)
2. For each received message:
   - Extract `table` (channel), `symbol`, `action`, and `timestamp`
   - **For deltas** (action = insert/update/delete):
     - If no snapshot exists yet for this channel:symbol pair, **drop the delta** (BitMEX warns that deltas may arrive before subscription confirmation)
     - If snapshot exists and delta timestamp is older than snapshot timestamp, **drop the delta** (out-of-order message)
   - **For snapshots** (action = snapshot), accept and store
   - Lookup all clients subscribed to exact `channel:symbol` using subscription index
   - For each subscribed client, send message to WebSocket
3. Continue consuming until shutdown

**Broadcasting:**
- Send is fire-and-forget: if a client's socket buffer is full, messages may be dropped (standard WebSocket behavior)
- No retry or persistence
- Latency: typically < 100ms from RabbitMQ to client, subject to network and queue capacity

**Error handling:**
- Parse errors: Log and skip
- Broadcast errors (e.g., client connection closed mid-send): Log and continue

#### `broadcastToSubscribers(channel, symbol, message)`

Broadcasts a message to all clients subscribed to a channel.

**Inputs:**
- `channel`: Channel name (e.g., `orderBookL2`)
- `symbol`: Symbol (e.g., `XBTUSD`)
- `message`: Serialized JSON to send

**Logic:**
1. Construct subscription key `channel:symbol`
2. Lookup clients in subscription index
3. For each client:
   - Serialize message to JSON
   - Send via `socket.send(json)`
   - Handle errors (closed connection, etc.)
4. Return count of clients sent to (for metrics)

### Snapshot Fetching on Subscribe

When a client subscribes to `orderBookL2:XBTUSD`:

1. **Immediate fetch from in-memory store:**
   - Lookup `orderBookL2:XBTUSD` in snapshots map
   - If found, send immediately to client

2. **Defer if snapshot not yet available:**
   - If snapshot not found, defer delivery to the client
   - The client subscription is active and will receive future updates
   - The snapshot will be sent to the client when it arrives (from Feed/Snapshots service)
   - See "Snapshot Subscription Flow" section below for details on how snapshot availability is ensured

### Connection Keep-Alive

**Server-to-client ping:** Every 30 seconds, send a WebSocket ping frame. Client responds with pong.

**Rationale:** Keeps idle connections alive and detects stale/dead clients so server can clean up resources.

### Snapshot Subscription Flow (Future Implementation)

**Overview:** Currently, bitmex-ws depends on Feed/Snapshots to proactively publish snapshots. A future enhancement will implement intelligent snapshot availability tracking to ensure snapshots are requested when needed.

**Design (not yet implemented):**
- When a client subscribes to a channel:symbol, check if there is an active subscription to BitMEX for that channel:symbol
- If no active subscription exists:
  - Send a subscription request to Feed service via the `feed-commands` RabbitMQ exchange
  - Feed will subscribe to BitMEX and eventually publish a snapshot
  - bitmex-ws sends the snapshot to the client once Feed publishes it
- If subscription is active:
  - If snapshot is available in-memory, send immediately
  - If snapshot is not available, request Feed to re-subscribe (in case of missed snapshot)
- Maintain a keep-alive mechanism to verify Feed subscriptions are still active
- Track pending snapshots to ensure clients waiting for snapshots are notified when they arrive

This design ensures that clients always eventually receive snapshots they request, even if Feed hasn't subscribed yet.

### Scalability & Isolation

**Horizontal scaling:** Multiple Bitmex-WS instances can run independently, each consuming the same RabbitMQ exchanges. Clients can distribute connections across instances or use a load balancer.

**No synchronization needed:** Each instance maintains its own snapshot cache and client subscriptions. Since snapshots are idempotent (latest version replacing older versions), multiple instances converge to the same state.

**Message delivery semantics:** At-most-once for deltas (if a client disconnects mid-send, the message is lost and not retried). This matches real WebSocket behavior and is acceptable for market data (next update will arrive shortly).
