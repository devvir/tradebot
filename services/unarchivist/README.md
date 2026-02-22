# Unarchivist Service

MongoDB-to-RabbitMQ polling service that continuously scans MongoDB collections and publishes documents to RabbitMQ. Automatically discovers new collections and resumes from previous polling positions on restart.

## How It Works

### Polling Algorithm

The service runs on a configurable interval and for each collection:

1. **Snapshot highest `_id`** in the collection
2. **Load previous state** (tracks last polled `_id` boundary and recent doc IDs)
3. **Get latest 1000 doc IDs** from collection (sliding buffer)
4. **Detect out-of-order writes** - IDs that fell out of the buffer are potential pending documents
5. **Process new documents** - Scan from previous boundary to current highest `_id`
6. **Update state** - Persist new boundary and buffer for next iteration

### State Management

- **In-memory**: Per-collection polling state (buffered IDs, boundary)
- **Persisted**: State saved to MongoDB `_unarchivist_state` collection with checkpoints for disaster recovery
- **Periodic saves**: State synced to MongoDB every iteration

### Dynamic Collection Discovery

Collections are discovered on each polling iteration, so:
- New collections added to MongoDB after service startup are automatically picked up
- Collections are polled sequentially in deterministic order
- Service starts immediately (doesn't require pre-existing collections)

## Configuration

Environment variables (see `.env` for defaults):

```
MONGODB_URL=mongodb://root:root@mongodb:27017/tradebot?authSource=admin
RABBITMQ_URL=amqp://guest:guest@rabbitmq:5672
UNARCHIVIST_COLLECTIONS=  # Empty = all collections (except _* system collections)
UNARCHIVIST_POLL_INTERVAL_MS=3000  # Interval between polls
```

## Message Publishing

Documents published to RabbitMQ exchange with routing key = collection name.

```
Topic Exchange: "archivist"
Routing Key: <collection_name> (e.g., "trades", "instrument")
Headers: { collection: <name> }
```

## Resumable

State is persisted in MongoDB, so on restart:
- Service loads previous polling positions
- Resumes scanning from where it left off
- No data loss on graceful shutdown

A built-in `unarchivist-test` queue binds to `#` for testing/debugging.

## Configuration

### Environment Variables

- `RABBITMQ_URL` - RabbitMQ connection string (default: `amqp://guest:guest@rabbitmq:5672`)
- `MONGODB_URL` - MongoDB connection string (default: `mongodb://root:root@mongodb:27017/tradebot?authSource=admin`)
- `UNARCHIVIST_BATCH_SIZE` - Scan batch size in documents (default: 1000)
- `UNARCHIVIST_COLLECTIONS` - Comma-separated collection whitelist (default: empty = all collections)
- `UNARCHIVIST_PORT` - Health check port (default: 3000)
- `LOG_LEVEL` - Log verbosity: debug, info, warn, error (default: info)

## Deduplication Strategy

Since the database is write-only (inserts only, no updates), duplicates only occur if the service restarts mid-Phase 1 or mid-Phase 2. Recommended deduplication strategies:

1. **Idempotent Handlers**: Consumers implement idempotent insert logic
   - E.g., "insert if not exists" or "upsert with _id"
   - Simplest and most efficient for write-only databases

2. **External Deduplication**: Use Redis to track processed `_id` values
   - Consumer stores `_id` in Redis after processing
   - Before processing new message, check if already processed
   - Cleanup after reasonable TTL

3. **Accept Duplicates**: Some services may not care (analytics, caching)
   - Publishing the same data multiple times is idempotent
   - Particularly safe for write-only data models

The service stays simple; deduplication is a consumer concern.

Progress is stored in MongoDB's `_unarchivist_state` collection:

```json
{
  "_id": "unarchivist-state",
  "isInitialScanDone": false,
  "lastCollectionScanned": "trades",
  "lastDocumentId": 12345,
  "changeStreamResumeToken": { ... },
  "lastUpdated": "2024-01-15T10:30:00Z"
}
```

- **isInitialScanDone**: Indicates whether phase 1 is complete
- **lastCollectionScanned**: Collection being scanned; used to resume
- **lastDocumentId**: Last `_id` processed in current collection; works with any `_id` type
- **changeStreamResumeToken**: Opaque token for resuming change stream
- **lastUpdated**: Timestamp of last state update

## Health Check

Endpoint: `GET http://localhost:3000/health`

Returns 200 if both MongoDB and RabbitMQ are connected; 503 if either is disconnected.

```json
{
  "mongoConnected": true,
  "mqConnected": true,
  "messagesPublished": 1234567,
  "lastPublishedTime": 1705318200000,
  "isInitialScanDone": true
}
```

## Behavior on Restart

1. **Checks state document**: Was initial scan done?
2. **If not done**: Resumes scanning from `lastCollectionScanned` and `lastDocumentId`
3. **If done**: Skips to phase 2, resumes change stream from `changeStreamResumeToken`

On restart, phase 2 may re-publish documents that arrived during Phase 1 scanning: this is expected and safe. Consumers should implement idempotent handlers.

## Limitations & Notes

- Does not filter duplicates (last occurrence wins; consumers should deduplicate if needed)
- Does not handle deletions (change streams don't capture them with `fullDocument`)
- Only processes inserts (optimized for write-only databases)
- Recent data may have out-of-order `_id` values due to non-time-only timestamp encoding
- Collections with non-ObjectId `_id` fields are supported but ordering is by `_id` insertion order only

## Graceful Shutdown

On `SIGTERM` or `SIGINT`:
1. Sets shutdown flag (current operations complete)
2. Closes MongoDB change stream
3. Closes MongoDB connection
4. Closes RabbitMQ connection
5. Exits

No data loss: state is checkpointed after each batch in phase 1 and after each change in phase 2.
