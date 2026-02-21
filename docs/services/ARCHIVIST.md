# Archivist Service

## Overview

The Archivist service consumes market data from RabbitMQ and persists it to MongoDB. It is intentionally generic and infrastructure-like: it knows nothing about data schemas, business logic, or structure. Publishers decide what gets stored; the Archivist just stores it.

## Design Philosophy

- **Generic storage layer**: No data validation or transformation. Receives a message, stores the result.
- **Header-based routing**: Collection name determined from the `table` header only.
- **Publisher-controlled structure**: Upstream services (e.g., codec) decide what fields go in the document via `headers.metadata` and message content.
- **Idempotent deduplication**: Duplicate insertions (same `_id`) are silently handled via MongoDB's unique index enforcement. Service treats error 11000 as success.
- **No ordering guarantees**: Processes messages as they arrive.

## Service Architecture

### Core Functions

#### `getCollectionName(msg)`
Extracts the `table` header from the RabbitMQ message. Throws if missing. Returns the table name as-is (no symbol suffix logic).

#### `createDocument(msg)`
Merges upstream metadata and parsed message content into a single document:
1. Extracts `headers.metadata` (optional, defaults to `{}`)
2. Parses message content:
   - If `contentType` is `application/json` (default): parse as JSON
   - If `application/octet-stream`: wrap in `{ message: Buffer }`
3. Merge: `{ ...metadata, ...content }`

Publishers can include fields like `_id`, `symbol`, `action`, or any custom property in `metadata`; they all become root-level document properties.

#### `startConsuming(channel, db, batchSize, onStoreMsg)`
Sets up RabbitMQ consumer:
1. Assert queue `archivist` (durable)
2. Set prefetch to `batchSize` for backpressure
3. For each message:
   - Extract collection name from `table` header
   - Build document from metadata + content
   - Insert into MongoDB
   - On success: ACK
   - On duplicate (`_id` conflict): ACK (idempotent)
   - On other error: NACK with requeue

### Message Structure

Publishers send RabbitMQ messages with:
```
headers:
  table: string (required)       # Destination collection name
  metadata: object (optional)    # Fields to include in document (e.g., _id, symbol)
contentType: string (optional)  # "application/json" or "application/octet-stream"
content: Buffer                 # JSON string or binary data
```

The final MongoDB document is: `{ ...metadata, ...parsedContent }`

### Graceful Shutdown

On `SIGTERM`/`SIGINT`:
1. Set shutdown flag
2. Close RabbitMQ connection
3. Close MongoDB client
4. Exit

## Edge Cases & Handling

### Duplicate Messages
Duplicate `_id` values fail with error 11000. Service catches this, logs, and ACKs (idempotent behavior).

### Connection Loss
Fatal condition; operator handles recovery. No automatic reconnection.

### Consumer Cancellation
RabbitMQ sends `null` to consumer callback. Service returns early without processing.

## Configuration

**`ARCHIVIST_BATCH_SIZE`** (default: 1000)
Controls RabbitMQ prefetch window. Provides backpressure.

## Health Monitoring

Exposes endpoint with:
- MongoDB connection status
- RabbitMQ connection status
- Messages processed (cumulative counter)
- Last processed timestamp

Returns HTTP 200 if both connections active; otherwise 503.


