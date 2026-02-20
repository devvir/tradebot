# Codec Service

## Overview

The Codec service is a message transformation processor that consumes BitMEX market data from a RabbitMQ message queue, applies optional custom transformations, and publishes the (optionally transformed) data to the downstream archival queue for persistence.

The service acts as a transparent transformation layer: it receives messages as quickly as the queue can deliver them, optionally applies user-defined transformations, and immediately publishes the result downstream. It makes no assumptions about message ordering or validity—it is a pure, stateless pipeline.

## Extended Definition

### What It Does

The Codec service provides a self-contained message transformation capability:

1. **Consumes from Message Queue**
   - Connects to RabbitMQ with automatic reconnection
   - Binds to the `bitmex-feed` durable queue
   - Maintains a prefetch window of 10 messages to control backpressure

2. **Applies Transformations (Placeholder)**
   - Currently implements pass-through behavior (no transformations applied)
   - Reserved as the extension point for custom message transformation logic
   - Can normalize field names, convert timestamps, calculate derived fields, filter data, etc.
   - Transformation function receives full BitMEX message and returns transformed message

3. **Publishes to Archival Queue**
   - Publishes transformed messages to the `archivist` durable queue
   - Marks messages as persistent (survive broker restart)
   - Tracks publication success or backpressure

4. **Provides Observability**
   - Exposes a health check endpoint at `:3000/health`
   - Tracks message processing and publishing metrics
   - Logs batch completions at regular intervals
   - Records last activity timestamp for staleness detection

### Design Philosophy

The Codec embodies these principles:

- **Pass-through by default**: The service is a null operation—messages flow through unchanged. This allows deploying the service immediately and adding transformations incrementally without risk.
- **Stateless transformation**: Each message is processed independently. No internal state is maintained beyond counters and health tracking.
- **Transparent flow**: Messages are neither buffered nor reordered. They are processed and published in the order received.
- **No validation**: The service doesn't validate message structure or content. It transforms what it receives and publishes the result, delegating validation to upstream (Feed) or downstream (Archivist) services.
- **Decoupled from consumers**: The service publishes to a queue (not a topic exchange), allowing a single Archivist consumer to receive all transformed data without subscription complexity.

### Architecture Diagram

```
Feed (bitmex-data exchange, bitmex-feed topic)
    ↓
bitmex-feed queue (durable, prefetch=10)
    ↓
Codec Service (reads, transforms, publishes)
    ↓
archivist queue (durable)
    ↓
Archivist Service (persists to MongoDB)
```

### Current Implementation

The `transformMessage` function in `src/transform.ts` is a placeholder:

```typescript
const transformMessage = (data: BitmexDataMessage): BitmexDataMessage => {
  // TODO: Add custom transformations here based on message table/action
  // Examples:
  // - Normalize field names
  // - Convert timestamps
  // - Calculate derived fields
  // - Filter sensitive data
  // For now, pass through as-is
  return data;
};
```

This can be extended to:
- **Normalize**: Map BitMEX field names to canonical names
- **Enrich**: Add computed fields (e.g., normalized prices in alternative currencies)
- **Filter**: Remove sensitive data (e.g., order IDs, counterparties)
- **Encode**: Compress or serialize data before downstream processing
- **Route**: Modify messages destined for different consumers

## Technical Details

### Service Lifecycle

**Startup sequence:**
1. Load configuration from environment (RabbitMQ URL)
2. Validate configuration (required URL present)
3. Connect to RabbitMQ with retry logic (unlimited retries, broker logs events)
4. Declare RabbitMQ topology (exchanges, queues)
5. Start consuming messages from `bitmex-feed` queue
6. Initialize health check endpoint on port 3000
7. Begin processing and publishing

**Graceful shutdown:**
- On `SIGTERM` or `SIGINT`, the service sets a shutdown flag
- Closes the RabbitMQ channel and connection
- Exits cleanly

### Core Functions

#### `connectToQueue(url: string): Promise<Broker>`

Establishes connection and declares topology.

**Topology:**
- Exchange: `bitmex-data` (type: `topic`, durable: `true`)
  - Queue: `bitmex-feed` (durable: `true`, routing key: `#`)
- Queue: `archivist` (durable: `true`)

#### `startConsuming(broker, onMessageReceived, onPublishMsg): Promise<void>`

Enters the consumption loop. For each message:

1. Consume from `bitmex-feed` queue
2. Parse message as `BitmexDataMessage`
3. Call `transformMessage()` on the message (currently pass-through)
4. Increment `messagesProcessed` counter
5. Publish to `archivist` queue with `persistent: true`
6. Increment `messagesPublished` counter
7. Acknowledge the message (remove from queue)
8. On error: nack with requeue to retry processing

Prefetch window: 10 messages (controls backpressure if downstream is slow)

#### `startHealthCheck(port: number, getState: () => HealthState)`

Exposes health endpoint on the given port.

**Endpoint:** `GET /health`

**Response (200 OK if healthy, 503 Service Unavailable if not):**

```json
{
  "status": "healthy|unhealthy",
  "mqConnected": true|false,
  "messagesProcessed": 12345,
  "messagesPublished": 12345,
  "lastProcessedTime": 5000
}
```

**Health criteria:**
- Healthy: MQ connected AND last processed message < 60 seconds ago
- Unhealthy: MQ disconnected OR no messages for > 60 seconds

### Message Flow Example

**Input (from bitmex-feed queue):**
```json
{
  "table": "trade",
  "action": "insert",
  "data": [{ "timestamp": "...", "symbol": "XBTUSD", "price": 42500, ... }],
  "keys": ["timestamp", "symbol"],
  "types": { "timestamp": "timestamp", "symbol": "symbol", ... }
}
```

**Transformation:** (currently none)

**Output (to archivist queue):**
```json
{
  "table": "trade",
  "action": "insert",
  "data": [{ "timestamp": "...", "symbol": "XBTUSD", "price": 42500, ... }],
  "keys": ["timestamp", "symbol"],
  "types": { "timestamp": "timestamp", "symbol": "symbol", ... }
}
```

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `RABBITMQ_URL` | `amqp://guest:guest@rabbitmq:5672` | RabbitMQ connection URL (URL-encoded special characters in credentials) |
| `LOG_LEVEL` | `info` | Logging level (trace, debug, info, warn, error, fatal) |

### URL Encoding

If credentials contain special characters (e.g., `user@domain:pass:word`), they must be URL-encoded:
- `@` → `%40`
- `:` → `%3A`
- `/` → `%2F`

Example:
```
RABBITMQ_URL=amqp://user%40domain:pass%3Aword@rabbitmq:5672
```

The service will decode and re-encode the URL during connection to handle both encoded and unencoded inputs.

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Clean shutdown (SIGTERM/SIGINT) |
| 1 | Startup failure (invalid config, RabbitMQ connection failure) |

## Scaling

- **Horizontal**: Multiple Codec instances can run concurrently; each consumes from the shared `bitmex-feed` queue with prefetch=10. Messages are distributed fairly across instances.
- **Vertical**: Not applicable; service uses minimal resources (single consumer connection, stateless processing).

## Future Extensions

Potential enhancements to the `transformMessage` function:

1. **Symbol mapping**: Convert `XBTUSD` → `BTC/USD` or similar
2. **Price normalization**: Convert to standard currency (e.g., all in USD)
3. **Timestamp conversion**: Normalize to milliseconds, UTC, ISO-8601
4. **Derived fields**: Compute bid-ask spread, relative volume, etc.
5. **Filtering**: Remove low-liquidity symbols, old events, etc.
6. **Tagging**: Add metadata (e.g., `source: "bitmex"`, `processed_at: ...`)
7. **Compression**: Encode large messages (e.g., order book snapshots) for efficient storage
8. **Routing**: Add queue hints for multi-consumer scenarios
