# Reader Service - Technical Documentation

## Overview

The Reader service implements a MongoDB collection polling mechanism that detects and publishes newly inserted documents via RabbitMQ. It handles out-of-order writes using a sliding window algorithm and persists polling state for recovery on restart.

## Architecture

### Polling Flow

```
Every READER_POLL_INTERVAL_MS
    ↓
For each collection (whitelist or all)
    ├─ Snapshot current highest _id (NEW HIGH)
    ├─ Load previous state (OLD HIGH, OLD BUFFER)
    ├─ Get latest 1000 _ids (NEW BUFFER)
    ├─ Detect pending _ids (in OLD BUFFER but not NEW BUFFER)
    ├─ Publish pending _ids (out-of-order documents)
    ├─ Scan from OLD HIGH to NEW HIGH
    ├─ Publish all documents in range
    ├─ Persist state (NEW HIGH, NEW BUFFER)
    └─ Move to next collection
```

### Sliding Window Algorithm

The service detects both newly inserted documents and out-of-order writes using a two-phase detection model:

#### Phase 1: Snapshot Current State
- Get current highest `_id` (the maximum `_id` value in collection)
- Get latest 1000 `_id` values (sorted ascending)
- Load previous boundary `oldHighId` and previous buffer `oldBufferedIds`

#### Phase 2: Detect Pending Documents
Pending documents are those with lower `_id` values that arrived after documents with higher `_id` values:
- If document had `_id` in `oldBufferedIds` but not in `newBufferedIds`, it "fell out"
- These documents may have been inserted out-of-order
- Query and publish each pending document individually

#### Phase 3: Detect New Documents
Standard forward scan detects documents inserted after the previous poll:
- If `newHighId > oldHighId` (or `oldHighId == null` on first run)
- Scan all documents with `_id` from `oldHighId` to `newHighId` (exclusive to inclusive)
- Publish all discovered documents

#### Phase 4: Update State
Persist new boundary and buffer for next poll cycle.

### State Management

#### In-Memory State (Per Collection)

```typescript
interface CollectionPollingState {
  collectionName: string;
  bufferedIds: Set<string>;    // Latest 1000 _id values
  lastHighId: string | null;   // Highest _id observed
}
```

#### Persisted State (MongoDB `_reader_state` collection)

```typescript
interface PersistedPollingState {
  _id: 'reader-state';
  timestamp: Date;
  orderedIds: {
    [collectionName]: {
      bufferedIds: string[];   // Latest 1000 _ids (array for storage)
      lastHighId: string | null;
    }
  };
}
```

Persisted after each polling iteration for disaster recovery.

## Configuration

### Environment Variables

| Variable | Type | Required | Description |
|----------|------|----------|-------------|
| `MONGODB_URL` | string | Yes | MongoDB connection URL |
| `READER_DATABASE` | string | Yes | Source database name |
| `RABBITMQ_URL` | string | Yes | RabbitMQ broker URL |
| `READER_EXCHANGE` | string | Yes | Destination exchange name |
| `READER_QUEUE` | string | Yes | Destination queue name |
| `READER_BATCH_SIZE` | number | Yes | RabbitMQ prefetch window |
| `READER_POLL_INTERVAL_MS` | number | Yes | Poll interval (milliseconds) |
| `READER_COLLECTIONS` | string | No | Comma-separated collection whitelist (default: all non-system collections) |

### Collection Discovery

- **If `READER_COLLECTIONS` empty:** All collections discovered dynamically on each poll (except `_*` system collections)
- **If `READER_COLLECTIONS` specified:** Only listed collections polled in order
- Dynamic discovery allows new collections created after service startup to be automatically picked up

## Document Publishing

Documents are published to RabbitMQ with:
- **Exchange:** Configured `READER_EXCHANGE`
- **Routing key:** Collection name (e.g., `trades`, `instrument`)
- **Content type:** `application/json`
- **Payload:** Full MongoDB document

## Dependencies

### MongoDB

- **Connection:** Standard MongoDB driver, no retry logic (startup only)
- **Operations:**
  - `listCollections()` - Discover collections to poll
  - `findOne(..., { sort: { _id: -1 } })` - Get highest `_id`
  - `find().sort({ _id: -1 }).limit(1000)` - Get latest buffer
  - `find({ _id: { $gt: start, $lte: end } })` - Scan range
- **Collections:**
  - Target collections: Any collection to poll
  - `_reader_state`: Persists polling state (created on demand)

### RabbitMQ

- **Publishing:** Topic exchange with routing key = collection name
- **Queue binding:** External concern (subscribers bind to exchange with routing key patterns)
- **Backpressure:** Respects prefetch via prefetch window

## Error Handling

### MongoDB Errors

During polling:
- **Collection not found:** Skipped (collection may have been dropped)
- **Connection error:** Propagated to health check (503)
- **Query error:** Logged, propagated to health check

During state persistence:
- **Update error:** Logged, but polling continues (next iteration will retry)

### RabbitMQ Errors

- **Connection error:** Propagated to health check (503)
- **Publish error:** Logged and retry initiated by broker

## Lifecycle

### Initialization

1. Load and validate configuration
2. Connect to MongoDB (no retry on failure)
3. Connect to RabbitMQ broker
4. Load persisted polling state from `_reader_state`
5. Restore in-memory collection states from persisted data

### Polling Loop

Runs periodically every `READER_POLL_INTERVAL_MS`:
1. Get collection list (whitelist or discovery)
2. For each collection: call `processCollection()`
3. Detect pending and new documents, publish each
4. Update persisted state checkpoint

### Graceful Shutdown

On `SIGTERM` or `SIGINT`:
1. Stop accepting new poll cycles
2. Allow in-flight documents to finish publishing
3. Close MongoDB connection
4. Close RabbitMQ broker
5. Exit

State is checkpointed after each poll cycle, so restart resumes from last checkpoint.

## Performance Characteristics

- **Throughput:** Depends on MongoDB query latency and RabbitMQ publish latency
- **Memory:** In-memory buffer is 1000 `_id` values per collection × number of collections
- **Latency:** Poll interval + time to scan and process documents in range
- **Scalability:** Horizontal scaling via sharding (assign collection subsets to different readers)

## Out-of-Order Write Handling

The sliding window algorithm handles MongoDB's eventual consistency when documents are inserted with non-monotonic `_id` values:

### Example Sequence

```
Time 1: Insert doc with _id=5
Time 2: Insert doc with _id=10
Time 3: Poll interval 1 - new buffer = [5, 10], oldHigh = null
        → Publish docs 1-10
        → State: lastHighId = 10, bufferedIds = [5, 10]

Time 4: Insert doc with _id=7 (delayed write, out-of-order)
Time 5: Poll interval 2 - new buffer = [7, 10], oldHigh = 10
        → Pending detection: 5 was in oldBufferIds but not in newBufferIds
        → Query and publish doc with _id=7
        → State: lastHighId = 10, bufferedIds = [7, 10]
```

The service successfully detects and publishes the out-of-order document on the next poll.

## Limitations

- **No deletion tracking:** Deleted documents are not published (MongoDB doesn't track deletions efficiently via polling)
- **No update tracking:** Only inserts detected; updates to existing documents not published
- **Buffer size fixed:** 1000-ID buffer is hardcoded (`BUFFER_SIZE` constant)
- **Collection-level granularity:** Polls entire collection, not specific query ranges
- **No deduplication:** Service may publish same document multiple times if polling restarts mid-iteration
- **_id ordering assumptions:** Assumes `_id` values are reasonably sequential or sortable (works with any comparable type)

## Disaster Recovery

### On Restart

1. Load persisted state from `_reader_state`
2. Restore in-memory collection states (bufferedIds + lastHighId)
3. Resume polling with previous boundaries

### Potential Duplicate Publishing

If service crashes mid-publish:
- On restart, may republish documents from previous poll
- Consumers should implement idempotent handling (e.g., upsert by `_id`)
- Or deduplication layer (e.g., Redis tracking processed `_id` values)

### State Loss Scenarios

- **State not yet persisted:** Poll cycle in progress at crash time may result in gap
  - Compensated by sliding window: pending detection on next poll catches most cases
  - Small window remains (documents inserted and discovered between crash and restart)
