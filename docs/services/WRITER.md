# Writer Service - Technical Documentation

## Overview

The Writer service is a generic message persistence component that consumes messages from a RabbitMQ queue and stores them in MongoDB. It handles document assembly, metadata enrichment, and gracefully manages duplicate key violations at the database level.

## Architecture

### Message Flow

```
RabbitMQ Queue
    ↓ (prefetch batchSize)
 Writer Service
    ├─ Extract routingKey from message metadata
    ├─ Create document: merge headers + content
    ├─ Select collection (routingKey → collection name)
    └─ insertOne() to MongoDB
         ├─ Success → ACK message
         └─ Duplicate key error → ACK message (silent)
         └─ Other error → NACK with requeue
```

### Document Assembly

The Writer combines message headers and content into a MongoDB document:

#### Input

RabbitMQ message structure:
```
Message {
  properties: {
    headers: {
      metadata: {
        _id: Buffer (big-endian int64),
        other_field: value,
        ...
      }
    },
    contentType: 'application/json' | 'application/octet-stream'
  },
  content: Buffer,
  fields: {
    routingKey: 'collection_name'
  }
}
```

#### Processing

1. **Extract routing key** → Determines target collection name
2. **Deserialize metadata headers:**
   - Buffer values are converted to BSON Long (big-endian int64)
   - Other values pass through unchanged
3. **Handle content based on content-type:**
   - `application/json`: Parse JSON string into object
   - `application/octet-stream`: Wrap binary data in `{ b: new Binary(buffer) }`
4. **Merge into document:** `{ ...metadata, ...data }`

#### Output

MongoDB document ready for insertion:
```javascript
{
  _id: Long(timestamp),                    // from metadata headers
  other_field: value,                      // from metadata headers
  // ... (other fields from content)
}
```

### Collection Routing

- **Routing key** from message metadata → **collection name**
- Collections are created on-demand during first insert
- No schema enforcement (MongoDB document collections)

## Configuration

### Environment Variables

| Variable | Type | Required | Default | Description |
|----------|------|----------|---------|-------------|
| `MONGODB_URL` | string | Yes | - | MongoDB connection URL |
| `WRITER_DATABASE` | string | Yes | - | Target database name |
| `RABBITMQ_URL` | string | Yes | - | RabbitMQ broker URL |
| `WRITER_EXCHANGE` | string | Yes | - | Source RabbitMQ exchange |
| `WRITER_QUEUE` | string | Yes | - | Source queue name |
| `WRITER_BATCH_SIZE` | number | Yes | - | RabbitMQ prefetch (messages buffered) |
| `WRITER_BATCH_TIMEOUT_MS` | number | Yes | - | Batch timeout window (ms) |

### Queue Configuration

- **Exchange binding:** Queue declares from configured exchange with routing key `#` (all messages)
- **Prefetch:** Controls RabbitMQ backpressure. Higher values = faster throughput, more memory; lower = more balanced consumption

## Dependencies

### MongoDB

- **Connection:** Standard MongoDB driver with exponential backoff retry (10 attempts, 5s delay)
- **Operations:** Single `insertOne()` call per message
- **Indexes:** Service assumes target collection has a unique index on `_id` (caller's responsibility)

### RabbitMQ

- **Consumption:** Persistent queue with manual ACK/NACK
- **Message format:** Expects `metadata` in message headers and routable via `routingKey`
- **Backpressure:** Respects prefetch window to prevent consumer overload

## Error Handling

### Duplicate Key Errors (MongoDB code 11000)

When `insertOne()` fails with a duplicate key constraint violation:
1. Error is suppressed (no log message)
2. Message is **acknowledged** (removed from queue)
3. Processing continues with next message

**Rationale:** Duplicate key errors indicate the document already exists in MongoDB. This is expected behavior when messages are reprocessed and should not block the pipeline.

### Other Errors

When any non-duplicate error occurs during `insertOne()`:
1. Error is logged with context
2. Message is **not acknowledged** (NACK with requeue)
3. Processing continues; broker will retry after backoff

**Errors recovered via retry:**
- Network timeouts
- MongoDB conn drops
- Document validation failures
- Other constraint violations (non-unique)

## Health Monitoring

### Health Check Endpoint

```
GET /health
```

**Healthy (200):**
- MongoDB connected
- RabbitMQ broker connected
- Messages processed within last 60 seconds

**Unhealthy (503):**
- MongoDB disconnected OR
- RabbitMQ disconnected OR
- No message activity for 60+ seconds

### Metrics

- **`messagesProcessed`** - Cumulative count of messages ACKed (successful + duplicates)
- **`lastProcessedTime`** - Milliseconds elapsed since last ACK

## Lifecycle

### Initialization

1. Load and validate configuration (all required env vars present)
2. Connect to MongoDB (exponential backoff: 10 retries, 5s delay between attempts)
3. Connect to RabbitMQ broker
4. Get channel from broker
5. Assert queue exists and establish consumer with prefetch window

### Graceful Shutdown

1. Disconnect RabbitMQ broker (stops consuming new messages)
2. Allow in-flight messages to complete processing
3. Close MongoDB client

## Performance Characteristics

- **Throughput:** Dependent on MongoDB latency, network, and prefetch window
- **Backpressure:** RabbitMQ prefetch window prevents memory overload
- **Scalability:** Horizontal scaling via multiple consumer instances (each with own prefetch window)

## Generic Design Principles

The Writer service makes **no assumptions** about:
- Message content structure or semantics
- Document ID generation or meaning
- Data type or business domain
- Message source or destination
- Broader system integration patterns

Input interface is purely:
- A message queue name and exchange
- Messages with metadata headers and routing keys
- A database name and connection URL

Output is MongoDB documents, keyed by routing key.
