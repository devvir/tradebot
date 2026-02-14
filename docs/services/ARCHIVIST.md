# Archivist Service

## Overview

The Archivist service is a message consumer that consumes BitMEX market data from a RabbitMQ message queue, deduplicates records based on domain-specific unique constraints, and persists the data to MongoDB for long-term storage and analysis.

The service acts as a transparent ingestion pipeline: it receives messages as quickly as the queue can deliver them, routes them to appropriate collections, stores each message with a deduplication hash, and deduplicates across multiple publishers via a unique index.

## Extended Definition

### What It Does

The Archivist service provides a self-contained data archival capability:

1. **Consumes from Message Queue**
   - Connects to RabbitMQ and binds to the `bitmex-data` topic exchange
   - Consumes from the `bitmex-feed` durable queue
   - Maintains a configurable prefetch window to control backpressure

2. **Deduplicates Records**
   - Creates a unique index on the `_hash` field (computed from message data items' timestamps, action, and data count)
   - Automatically silences duplicate key errors (error code 11000) when identical messages arrive from multiple publishers
   - Treats duplicate delivery as idempotent—acknowledged and discarded

3. **Persists to MongoDB**
   - Routes incoming messages to collection tables based on the message's `table` field and (for high-volume channels) the symbol
   - Stores the complete message (table, action, data array, keys, types) as-is
   - Tracks insertion health via message counters

4. **Provides Observability**
   - Exposes a health check endpoint reporting connection status and ingestion metrics
   - Logs batch completions at configurable intervals
   - Maintains state on messages processed and last processing time

### Design Philosophy

The Archivist embodies these principles:

- **Infrastructure-like**: The service doesn't validate downstream usage. It writes what it receives and lets MongoDB handle uniqueness constraints.
- **Transparent storage**: Messages are stored exactly as received from BitMEX. A `timestamp` field is extracted to the root level for indexing, and a `_hash` is computed for deduplication, but no other modification happens.
- **Hash-based deduplication**: The _hash combines message timestamp (minimum across data array), action, and data count. Identical messages from different publishers produce identical hashes and trigger duplicate key errors.
- **No ordering guarantees**: The service makes no promise to insert messages in order. It processes them as they arrive, so derived data may be out of order relative to real-world events.
- **Decoupled from producers**: Multiple feed service instances can publish the same message without causing duplicates—the _hash index deduplicates across publishers.

### Collection Mapping Strategy

The service routes data to collections using a simple, deterministic algorithm:

**High-volume channels get symbol-segregated collections:**
- `orderBookL2` → `orderBookL2_XBTUSD`, `orderBookL2_ETHUSD`, etc.
- `quote` → `quote_XBTUSD`, `quote_ETHUSD`, etc.
- `trade` → `trade_XBTUSD`, `trade_ETHUSD`, etc.

**Other channels get unified collections:**
- `liquidation` → `liquidation` (symbol already in document)
- `funding` → `funding`
- `settlement` → `settlement`
- `instrument` → `instrument`
- `insurance` → `insurance`

**Why?** High-volume channels produce vastly more documents per second. Splitting them by symbol prevents a single collection from becoming a bottleneck. Lower-volume channels don't produce enough throughput to justify the complexity of partitioning.

## Technical Details

### Service Lifecycle

**Startup sequence:**
1. Load configuration from environment (MongoDB URL, RabbitMQ URL, batch size)
2. Validate configuration (required fields present)
3. Connect to MongoDB with retry logic (up to 10 retries, 5-second intervals)
4. Connect to RabbitMQ with retry logic (up to 10 retries, 3-second intervals)
5. Initialize health check endpoint
6. Start consuming messages

This ordering is deliberate: MongoDB must be ready before consuming messages, because message loss would occur if messages arrive before the database is available.

**Graceful shutdown:**
- On `SIGTERM` or `SIGINT`, the service sets a `isShuttingDown` flag
- Closes the RabbitMQ channel
- Closes the RabbitMQ connection
- Closes the MongoDB client
- Exits cleanly

### Core Functions

#### `startConsuming(channel, db, batchSize, onStoreMsg)`

The primary consumption loop. This function sets up the message consumer and processes each message.

**Flow:**
1. Assert the RabbitMQ exchange (`bitmex-data`, topic, durable)
2. Assert the queue (`bitmex-feed`, durable)
3. Bind the queue to the exchange with routing key `#` (catch-all)
4. Set channel prefetch to `batchSize`
5. Enter the consume callback loop:
   - Parse incoming JSON
   - Extract `table` and symbol for collection routing
   - Extract minimum timestamp from data array and compute deduplication hash
   - Store entire message with root-level `timestamp` and `_hash` fields
   - Ensure collection indexes are created (once per collection per service lifetime)
   - Extract minimal attributes from each document in the message's `data` array
   - Attempt bulk insertion with `ordered: false` (continue on individual failures)
   - Handle duplicate key errors (code 11000) by acknowledging and moving on
   - For other errors, negative acknowledge (nack) with `requeue=true` to retry

**Error handling:**
- **Duplicate key (11000)**: Treated as success—acknowledged and logged at debug level
- **Other insertion errors**: Negative-acknowledged and requeued for later retry
- **Parse or extraction errors**: Negative-acknowledged and requeued
- **Connection errors**: Bubble up and fail the service (operator must restart)

**Backpressure handling:**
- RabbitMQ prefetch window (`batchSize`) provides built-in backpressure
- If the database is slow, the prefetch buffer fills up, and producer (feed service) is held at the publish point
- No additional backpressure logic needed; RabbitMQ's ACK/NACK mechanism handles it

#### `ensureIndexedCollection(db, collectionName)`

Ensures unique indexes exist for a collection, but only checks once per collection per service lifetime.

**Design:**
- Maintains a `Set<string>` of collections that have been indexed
- On first call for a collection:
  - Check if collection exists; create if not
  - Fetch the index specification for the collection from `indexes.ts`
  - Create the unique index
  - Add to the indexed set
- On subsequent calls for the same collection:
  - Callback is a no-op (already in indexed set)

**Why only once?** In MongoDB, attempting to create an index that already exists is a no-op, so checking every time is wasteful. Since the service runs continuously and doesn't drop collections, once an index exists, it stays.

**Index design:**
Indexes are based on BitMEX API documentation and data structure:
- **trade**: `trdMatchID` (GUID, globally unique per trade)
- **orderBookL2**: Compound on `{symbol, id, side}` (composite natural key)
- **quote/quoteBin***: Compound on `{timestamp, symbol}` (time-series unique)
- **liquidation**: `orderID`
- **funding**: `{timestamp, symbol}` (time-series unique)
- **settlement**: `{timestamp, symbol}` (time-series unique)

#### `getHealthState()`

Returns current health metrics.

**Fields:**
- `mongoConnected`: Boolean, true if MongoDB client is active
- `mqConnected`: Boolean, true if RabbitMQ channel is active
- `messagesProcessed`: Running counter of successfully ACK'd messages
- `lastProcessedTime`: Milliseconds elapsed since the last message ACK (returned in the health response; used to detect staleness)

**Use case:** Operators can poll the health endpoint to confirm the service is alive and ingesting data. The health endpoint returns HTTP 200 if both databases are connected AND the service has processed a message within the last 60 seconds; otherwise returns 503.

#### MongoDB Connection with Retry

```typescript
const connectMongoWithRetry = async (maxRetries = 10, delayMs = 5000)
```

Attempts connection up to N times with exponential backoff:
- Tries to connect
- If successful, returns and proceeds
- If failed, logs the attempt, waits `delayMs`, retries
- If all retries exhausted, throws

**Motivation:** MongoDB might not be ready when the service starts (especially in containerized environments). Retry logic allows the service to wait for dependencies to stabilize.

### Data Flow Through the System

```
Incoming Message (JSON from RabbitMQ)
    ↓
Parse JSON → Extract table, data array, metadata
    ↓
Determine collection name (using symbol-segregation logic)
    ↓
Ensure indexes on collection (once per collection)
    ↓
For each document in data array:
    - Store as-is
    ↓
insertMany with ordered=false
    ↓
On success: ACK message
    On duplicate (11000): Log debug, ACK message
    On other error: NACK with requeue=true
```

### Edge Cases and Handling

#### Duplicate Records

**Scenario**: The feed service publishes the same data twice (network retry, replay, etc.).

**Handling**: When the Archivist attempts to insert both records, the second fails with error code 11000 (duplicate key). The service catches this error, logs it at debug level, and ACKs the message. The duplicate is silently discarded.

**Why this approach?** It's simpler than maintaining deduplication state. Unique indexes are the source of truth; MongoDB enforces the constraint, and the service respects it.

#### Out-of-Order Insertions

**Scenario**: Messages arrive out of order. Message B's timestamp is earlier than Message A's, but Message A is inserted first.

**Handling**: The service doesn't reorder. It inserts as received. Collections are *not* sorted by timestamp; they're sorted by insertion order (or by explicit query sorting).

**Why this approach?** Reordering would require buffering, state management, and complex timing logic. The service assumes downstream consumers handle temporal analysis and will sort by timestamp when needed.



#### Collection Creation

**Scenario**: A new symbol or channel arrives that has never been seen before.

**Handling:** MongoDB's `insertMany` creates the collection automatically if it doesn't exist. The service doesn't need to pre-create collections or manage schemas; it relies on MongoDB's schemaless design.

**Why this approach?** No need to manage DDL (data definition language) statements or pre-allocate collections. Collections are created organically as data arrives.

#### Connection Loss

**Scenario**: MongoDB or RabbitMQ becomes unavailable mid-operation.

**Handling:**
- If MongoDB connection is lost during insertion, the query throws an error, gets caught, and is negative-acknowledged (requeued)
- If RabbitMQ connection is lost, the service logs the error but doesn't actively reconnect; it's a fatal condition
- The service assumes an operator will restart it or a container orchestrator will recover it

**Why no automatic reconnection?** The service is designed to be infrastructure-like. It doesn't try to heal itself. If it fails, it fails, and the operator must take action.

#### Message Not Acknowledged

**Scenario**: The service crashes after processing a message but before ACKing.

**Handling**: RabbitMQ's durable queue configuration ensures the message is redelivered. The Archivist will attempt to process it again, likely hitting a duplicate key error (idempotent). The duplicate is silently ignored and ACK'd. No data loss.

**Why this works?** Unique indexes make message processing idempotent. Reprocessing the same message twice (or N times) produces the same result.

#### Batch Size Tuning

**Scenario**: The operator wants faster or slower ingestion.

**Configuration**: The `ARCHIVIST_BATCH_SIZE` environment variable (default 100) controls the RabbitMQ prefetch window. Increasing it allows more messages to be buffered locally, providing higher throughput at the cost of memory. Decreasing it provides finer-grained backpressure.

**Why adjust it?** If the database is very slow, high batch size can cause memory buildup. If the network is very slow, low batch size can be suboptimal. The operator should tune based on their infrastructure.

### Backpressure Model

The Archivist uses **pull-based backpressure** via RabbitMQ's prefetch mechanism:

1. Feed service publishes messages to the exchange
2. RabbitMQ routes to the `bitmex-feed` queue
3. Archivist sets prefetch to N messages
4. RabbitMQ delivers up to N messages, then waits for ACKs
5. If Archivist is slow to ACK (e.g., database is slow), RabbitMQ buffer fills and feed service's publishes slow down
6. Feed service naturally backs off as RabbitMQ's socket buffer fills

**No explicit rate limiters needed.** The infrastructure (RabbitMQ's buffering, TCP socket buffers) provides natural backpressure.

### Performance Considerations

#### Batch Insertion

The service uses `insertMany` with `ordered: false`. This tells MongoDB to continue inserting remaining documents even when some fail due to duplicate key violations, rather than stopping at the first error.

**Deduplication mechanism:** With `ordered: false`, MongoDB still throws an error if any documents fail (including duplicate key violations with error code 11000), but it attempts to insert all documents in the batch before throwing. The service catches error code 11000 specifically, treating duplicates as successful operations (acknowledging the message). This means duplicates are filtered out via unique index constraints, and the service handles the error gracefully by ACKing and logging at debug level.

**Throughput benefit:** Instead of inserting one record at a time (N round trips) or failing the entire batch on the first duplicate (with `ordered: true`), `ordered: false` allows MongoDB to attempt all inserts in the batch, maximizing throughput while safely handling duplicates via error handling.

#### Index Strategy

Unique indexes ensure deduplication without maintaining in-memory state. The database enforces uniqueness; the service doesn't.

**Trade-off:** Unique indexes slow down *writes* slightly (extra constraint check) but provide data integrity guarantees. The service prioritizes correctness over raw write speed.



### Monitoring

The service exposes metrics via the health check endpoint:

- **messagesProcessed**: Cumulative count of ACK'd messages
- **lastProcessedTime**: Timestamp of the most recent ACK

**Usage:** An operator could query this endpoint periodically to verify the service is making progress. If `messagesProcessed` stops incrementing, the service is likely blocked (database too slow, network issue, etc.).

### Idempotency Guarantees

The Archivist provides **idempotent consumption**:
- Processing the same message twice produces the same result (duplicate silently ignored)
- Restarting the service doesn't lose data
- Network retries from the feed service don't cause duplicates to survive

**Why this matters:** In distributed systems, guaranteeing "exactly once" semantics is expensive. Instead, the Archivist guarantees "at least once" consumption (messages definitely arrive) combined with idempotent insertion (duplicates have no effect). Together, this provides a practical data integrity guarantee.
