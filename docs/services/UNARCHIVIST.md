# Unarchivist Service - Technical Details

Polling-based MongoDB collection scanner that publishes documents to RabbitMQ. Continuously scans collections at a configurable interval, detects new and out-of-order documents, and maintains resumable polling state.

## Architecture

### Core Algorithm

For each collection on each poll iteration:

1. **Snapshot current maximum `_id`** in the collection (NEW HIGH)
   - Single index scan, very fast even on large collections
   - `_id` is always indexed in MongoDB

2. **Get previous polling state** (null on first run)
   - In-memory: boundary `_id` and recent buffered `_id`s
   - Persisted: checkpoint saved in MongoDB for disaster recovery

3. **Fetch latest 1000 document `_id`s** from collection
   - Deterministic ordering by `_id` (descending, then sort ascending)
   - Sliding window to catch out-of-order inserts

4. **Detect pending out-of-order documents**
   - Compare old buffer against new buffer
   - IDs that fell out of buffer = potential out-of-order writes still pending
   - Re-fetch and publish these documents

5. **Scan new documents** from previous boundary to current maximum
   - If boundary changed OR first run: fetch all docs in range
   - Publish each document via `onMessage` callback

6. **Update state**
   - New boundary = current maximum `_id`
   - New buffer = latest 1000 `_id`s
   - Persisted to MongoDB for resumable restarts

### State Management

#### In-Memory State

Per-collection polling state (lost on restart):
```typescript
interface CollectionPollingState {
  collectionName: string;
  bufferedIds: Set<string>;      // Last 1000 _ids (for out-of-order detection)
  lastHighId: string | null;      // Boundary _id (furthest polled)
}
```

Stored in module-level `collectionStates` map.

#### Persisted State

MongoDB `_unarchivist_state` collection (survives restart):
```typescript
interface PersistedPollingState {
  _id: "unarchivist-state";
  timestamp: Date;
  orderedIds: {
    [collectionName]: {
      bufferedIds: string[];      // Last 1000 _ids as array
      lastHighId: string | null;
    }
  }
}
```

Loaded on service startup via `loadPollingState()`, saved periodically via `startPeriodicStateSave()`.

### Collection Discovery

Collections discovered dynamically on **each polling iteration**:
- Queries MongoDB for all non-system collections
- Filters by whitelist if configured (empty = all)
- New collections automatically picked up mid-run
- Removed collections gracefully skipped if missing

## Configuration

### Environment Variables

```bash
# MongoDB connection
MONGODB_URL=mongodb://root:root@mongodb:27017/tradebot?authSource=admin

# RabbitMQ connection
RABBITMQ_URL=amqp://guest:guest@rabbitmq:5672

# Collection whitelist (empty = all collections)
UNARCHIVIST_COLLECTIONS=trades,instrument,indexSymbols

# Polling interval in milliseconds
UNARCHIVIST_POLL_INTERVAL_MS=3000
```

### Constants

```typescript
BUFFER_SIZE = 1000           // Sliding window for out-of-order detection
POLL_INTERVAL_MS = 3000      // Default interval between polls
```

## Message Publishing

### RabbitMQ Setup

- **Exchange**: `"archivist"` (topic type)
- **Routing Key**: Collection name (e.g., `"trades"`, `"instrument"`)
- **Content Type**: `"application/json"`
- **Headers**: `{ collection: <name> }`

### Publishing Flow

1. `processCollection()` scans collection and finds new/pending documents
2. Calls `onMessage` callback for each document (injected from service layer)
3. Service callback publishes via `broker.getExchange('archivist').publish()`
4. Increments activity counters for health checks

## Lifecycle & Health

### Service Lifecycle

- **onInit**: Connect to MongoDB and RabbitMQ
- **onPing**: Return activity metrics
  - `messagesPublished`: Total count
  - `lastProcessedTime`: Milliseconds since last document
  - `mongoConnected`: Boolean
  - `brokerConnected`: Boolean
- **isHealthy()**: True if both connections active AND activity within 5 minutes

### Graceful Shutdown

- Sets `state.isShuttingDown = true` to prevent new polls
- Closes MongoDB connection
- Closes RabbitMQ connection
- Exits process

## Polling Loop

### Interval Behavior

Uses **recursive `setTimeout`** (not `setInterval`):
1. Execute poll iteration (may take seconds)
2. When complete, schedule next iteration
3. Wait X ms
4. Start next iteration

**Advantage**: Spacing between polls is predictable regardless of iteration duration.

Example: 3-second interval
- Poll completes at 0ms → schedules next at +3000ms
- Poll completes at 2500ms → schedules next at +5500ms
- Never overlapping, always X seconds after completion

### Empty Collections

Service starts even if no collections exist:
- Logs `"No collections to process this iteration"` at debug level
- Waits for interval, tries again on next iteration
- Useful for services that need to wait for schema creation

## Resumable Data Tracking

### On Service Restart

1. Load peristed state from MongoDB `_unarchivist_state`
2. For each collection, restore:
   - `lastHighId` (resume scanning from this `_id`)
   - `bufferedIds` (to detect out-of-order catches)
3. Next poll iteration continues seamlessly

### On Failed State Load

- Logs error with context
- Service exits with code 1
- Operator should investigate MongoDB connectivity
- State file (`_unarchivist_state`) persisted, so retry will recover

## Out-of-Order Detection Algorithm

MongoDB doesn't guarantee `_id` insertion order (especially with:
- Sharded collections
- Concurrent bulk inserts
- ObjectId generation across multiple servers

Unarchivist handles this:

```
Iteration 1: lastHighId = "100", buffer = [95, 96, ..., 99, 100]
  (fetches docs 1-100)

Iteration 2: newHighId = "105", newBuffer = [101, 102, ..., 105]
  (fetches docs 101-105)
  BUT: Document with _id=98 still doesn't exist
  (out-of-order insert pending)

Iteration 3: newHighId = "106", newBuffer = [98, 102, 103, ..., 106]
  (98 fell out of buffer!)
  Detects: 98 was in old buffer but missing in new buffer
  Fetches doc 98 specifically
  Then fetches docs 106+
```

Buffer size of 1000 catches typical out-of-order delays. Larger buffers catch later arrivals.

## Performance Tuning

### For Large Collections

- **Increase `BUFFER_SIZE`** if out-of-order inserts arrive after many more docs
- **Increase `POLL_INTERVAL_MS`** to reduce CPU load
- **Reduce via whitelist** to only necessary collections

### For Bursty Traffic

- Reduce `POLL_INTERVAL_MS` (3000ms default may miss spikes)
- Monitor `lastProcessedTime` in health checks

### Memory

- Service in-memory state is minimal (just collection metadata + 1000 IDs per collection)
- MongoDB state collection is single document (stays < 1MB even with 100 collections)

## Troubleshooting

### No Documents Published

1. Check MongoDB connection: `health/{mongoConnected: true}`
2. Verify collection exists and has data
3. Check RabbitMQ connection: `health/{brokerConnected: true}`
4. Increase log level to DEBUG to see per-collection processing
5. Verify collection whitelist (if configured)

### Out-of-Order Gaps

If documents are missing in downstream services:
- Increase `UNARCHIVIST_BUFFER_SIZE` environment variable
- Check for bulk insert operations that may reorder documents
- Monitor logs for skipped collections

### Memory Issues

- State collection shouldn't grow large (kept clean in MongoDB)
- Service holds minimal in-memory state
- If RAM high, check MongoDB client memory usage
