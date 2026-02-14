# Snapshots Service

## Overview

The Snapshots service is a message consumer that processes BitMEX market data from a RabbitMQ message queue, intelligently aggregates delta-based channels (such as `orderBookL2` and `quote`) into complete snapshots, and publishes the aggregated snapshots to a separate message exchange for downstream consumption.

The service acts as a **real-time state aggregator**: it receives raw feed messages (atomic updates and deltas), maintains in-memory snapshots for channels that require aggregation, resolves deltas to build complete market pictures, and publishes the resulting snapshots to the `bitmex-snapshots` exchange. Downstream consumers (like Bitmex-WS) can subscribe to snapshots without affecting each other, and can independently consume raw deltas from the original feed.

## Extended Definition

### What It Does

The Snapshots service provides a self-contained state aggregation capability:

1. **Consumes from Message Queue**
   - Connects to RabbitMQ and binds to the `bitmex-data` topic exchange
   - Binds to a durable queue to receive all messages published by the Feed service
   - Maintains a configurable prefetch window to control backpressure

2. **Maintains In-Memory Snapshots**
   - Allocates per-channel snapshots: one for each resolvable `channel:symbol` combination that requires aggregation (e.g., `orderBookL2:XBTUSD`, `quote:ETHUSD`)
   - Stores the most recent complete snapshot in memory, indexed by `channel:symbol`
   - Initializes snapshots from the first received message of that type (or bootstrap from `snapshot` action messages from BitMEX)
   - Updates snapshots reactively as new messages arrive

3. **Deduplicates Processing**
   - Tracks recently processed messages by ID (in-memory set, short time window) to handle duplicates gracefully
   - Silently discards duplicate messages (same ID seen within the dedup window)
   - No persistence of dedup state—relies on short-window assumption: duplicates only occur in seconds-long intervals, not hours

4. **Aggregates Delta-Based Channels**
   - For channels like `orderBookL2` and quote-like channels: interprets `insert`, `update`, `delete` actions as deltas
   - Applies deltas to the existing snapshot: new entries inserted, existing entries updated/overwritten, entries deleted
   - Interpolates missing fields from previous snapshot when necessary (e.g., if an update only contains ID and side, fill in price, size from previous state)
   - Handles out-of-order messages by reapplying deltas against the most recent known snapshot (idempotent reconciliation)
   - Non-aggregated channels are silently ignored (e.g., `trade`, `liquidation`, `funding`—these don't require aggregation and are left for other consumers)

5. **Publishes Aggregated Snapshots**
   - Publishes snapshots to the `bitmex-snapshots` topic exchange with routing key `snapshot:channel:symbol` (e.g., `snapshot:orderBookL2:XBTUSD`)
   - Each snapshot is enriched with aggregation metadata: `_snapshotId` (version of the snapshot), `_processedAt` timestamp
   - Snapshots are published when the service processes relevant deltas for that channel/symbol
   - Downstream consumers (Bitmex-WS, potential future aggregators) can independently subscribe to these snapshots without affecting Feed or each other

7. **Provides Observability**
   - Exposes a health check endpoint reporting connection status and aggregation metrics
   - Logs snapshot updates at configurable intervals (e.g., "Updated 15 snapshots in last 10 seconds")
   - Tracks state on snapshots maintained, messages processed, and deduplicated count

### Design Philosophy

The Snapshots embodies these principles:

- **Isolation of concerns**: Aggregation happens here and nowhere else. Feed publishes raw data, Snapshots aggregates state and publishes snapshots, Bitmex-WS and other consumers independently subscribe to what they need.
- **Eventual consistency**: Snapshots may temporarily be out of order if messages arrive out of sequence. However, the service corrects itself as later messages arrive, so the snapshot converges to the true state.
- **Ephemeral deduplication**: Duplicate tracking happens in-memory with a short TTL. The assumption is that duplicates (if any) occur within seconds of the original message, not hours later.
- **Stateless publication**: Once a snapshot is published, the service forgets about it. Persistence and re-consumption are RabbitMQ's job.
- **Selective consumption**: The service only subscribes to topics for channels that require aggregation, leaving other data untouched for other consumers.

### Channel Aggregation Strategy

Channels are classified into two categories:

#### Aggregated Channels (Require Snapshot Building)
- `orderBookL2`: Order book updates via deltas (insert/update/delete). Snapshot = full order book.
- `orderBook10`: Same as `orderBookL2`, lower depth.
- `quote`: Best bid/ask updates. Snapshot = latest quote.
- `quoteBin1m`, `quoteBin5m`, `quoteBin1h`, etc.: Binned quotes. Snapshot = latest bin.

**Process:**
1. Receive message with `action: insert/update/delete`
2. Apply action to snapshot: insert new entries, update existing by ID/key, remove deleted entries
3. Publish updated snapshot with routing key `snapshot:orderBookL2:XBTUSD`
4. Publish delta (original message) with routing key `delta:orderBookL2:XBTUSD`
5. Advance snapshot version ID (`_snapshotId`)

#### Non-Aggregated Channels
- `trade`: Completed trades. No aggregation needed; each message is standalone.
- `liquidation`: Liquidation events. Standalone, no state.
- `funding`: Funding payouts. Standalone, historical.
- `settlement`: Settlement events. Standalone, historical.
- `instrument`: Instrument metadata. Standalone.
- `insurance`: Insurance fund metrics. Standalone.

**Process:**
These channels are ignored by Snapshots. The raw feed messages are available directly from the `bitmex-data` exchange for any consumer that needs them (e.g., Bitmex-WS consumes these directly).

### Message Deduplication

The service tracks processed messages to prevent duplicate aggregation:

**Mechanism:**
- Maintain a set of recently seen message IDs (e.g., `Set<string>`)
- On receiving a message, hash the message content or extract a unique ID
- If ID is in the set, discard (duplicate)
- If ID is new, process and add to set
- Periodically evict old IDs from the set based on age (e.g., evict IDs older than 60 seconds)

**Why in-memory?** BitMEX's WebSocket connection produces duplicates only on reconnect, which happens in seconds. Persisting to a database would add unacceptable latency. In-memory is sufficient and fast.

## Technical Details

### Service Lifecycle

**Startup sequence:**
1. Load configuration from environment (RabbitMQ URL, aggregation config)
2. Validate configuration (required fields, sensible ranges)
3. Connect to RabbitMQ with retry logic (up to 10 retries, 3-second intervals)
4. Assert `bitmex-data` exchange (source) and `bitmex-snapshots` exchange (sink)
5. Assert source queue and bind to `bitmex-data` exchange with routing key `#` (catch-all)
6. Initialize in-memory snapshot store (empty map, keyed by `channel:symbol`)
7. Initialize in-memory dedup set (empty set)
8. Initialize health check endpoint
9. Start consuming messages

**Graceful shutdown:**
- On `SIGTERM` or `SIGINT`, set `isShuttingDown` flag
- Close RabbitMQ channel
- Close RabbitMQ connection
- Flush any pending publishes (ensure all updates are sent before exit)
- Exit cleanly

### Core Functions

#### `startConsuming(channel, dedupWindow)`

The primary consumption loop. This function sets up the message consumer and processes each message.

**Flow:**
1. Assert source queue bound to `bitmex-data` exchange with selective routing (only aggregation-needed channels)
2. Enter consume callback loop:
   - Parse incoming JSON message
   - Check dedup set: if present, acknowledge and skip
   - Add ID to dedup set
   - Extract `table` (channel), `symbol`, and `action` from message
   - Route to appropriate aggregation handler based on channel type
   - Aggregate snapshot
   - Publish updated snapshot to `bitmex-snapshots` exchange
   - Acknowledge message
   - On error, negative acknowledge with `requeue=true` to retry

**Error handling:**
- **Parse errors**: Negative acknowledge and requeue
- **Dedup set lookup**: Always succeeds (set operation)
- **Aggregation errors**: Log and negative acknowledge (operator intervention needed)
- **Publish errors**: Negative acknowledge and requeue

**Dedup eviction:**
- Maintain a timestamp map alongside the dedup set
- Periodically (e.g., every 30 seconds) scan for entries older than `dedupWindow` (default 60 seconds)
- Remove aged entries from both set and timestamp map

#### `aggregateSnapshot(channel, snapshot, message)`

Applies a delta message to an existing snapshot.

**Inputs:**
- `channel`: Channel name (e.g., `orderBookL2`)
- `snapshot`: Current snapshot state (map or array, channel-specific)
- `message`: Incoming message with `action`, `data` array

**Logic:**
1. Extract `action` from message: `insert`, `update`, `delete`, or `snapshot` (full replacement)
2. Iterate over `message.data`:
   - **insert**: Add new entry to snapshot
   - **update**: Find entry by ID/key in snapshot, merge fields from message
   - **delete**: Remove entry from snapshot by ID/key
   - **snapshot**: Replace entire snapshot with incoming `data` array
3. Return updated snapshot
4. Increment snapshot version ID

**Idempotency:**
- If an update arrives for an entry not in snapshot, insert it (graceful degradation)
- If a delete arrives for an entry not in snapshot, ignore it
- Apply updates by ID/composite key, ensuring correctness even if messages arrive out of order

#### `publishSnapshot(channel, snapshot, exchange, routing)`

Publishes an aggregated snapshot to the `bitmex-snapshots` exchange.

**Logic:**
1. Wrap snapshot in envelope with metadata:
   ```json
   {
     "table": "orderBookL2",
     "symbol": "XBTUSD",
     "action": "snapshot",
     "data": [...],
     "_snapshotId": "uuid-v4",
     "_processedAt": "2026-02-14T12:34:56.789Z"
   }
   ```
2. Publish to `bitmex-snapshots` exchange with routing key `snapshot:orderBookL2:XBTUSD`
3. Return promise (or callback) on publish success



### Snapshot Storage

**In-memory structure:**
```javascript
snapshots = {
  "orderBookL2:XBTUSD": { id: [...], data: [...] },
  "orderBookL2:ETHUSD": { id: [...], data: [...] },
  "quote:XBTUSD": { bid: ..., ask: ... },
  // ...
}
```

**Key design decision:** Snapshots are keyed by `channel:symbol`, allowing fast lookup and update. Updates are idempotent—overwriting the same key is safe.

**Memory footprint:** Depends on channel depth (order book size, number of symbols). For typical trading pairs (hundreds of symbols) and order book depths (thousands of orders), expect 10s of MB to low 100s of MB.

### Dedup Window Configuration

The dedup window determines how long an ID is tracked before eviction from the dedup set.

**Default:** 60 seconds

**Rationale:** BitMEX websocket reconnects typically replay messages within a few seconds. 60 seconds provides a comfortable margin while remaining efficient in memory.

**Configuration:** `SNAPSHOTS_DEDUP_WINDOW_SECONDS` env var.
