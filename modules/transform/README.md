# Extract Module

MongoDB-to-RabbitMQ data extraction. Continuously scans MongoDB collections and publishes documents to RabbitMQ for downstream processing (transformation, storage, etc.).

## Services

### MongoDB
- Persistent document database where source data is stored
- Collections are scanned at configurable interval
- Tracks polling state in `_unarchivist_state` collection for resumable scanning

### RabbitMQ
- Message broker for pub/sub communication
- Topic exchange `"archivist"` receives extracted documents
- Routing keys match collection names for targeted consumption

### Unarchivist
Polling-based extraction service that continuously scans MongoDB collections:
- Runs on configurable interval (default 3 seconds)
- Automatically discovers new collections
- Publishes new/modified documents to RabbitMQ
- Maintains resumable state in MongoDB
- Detects out-of-order writes using sliding buffer algorithm

## Usage

Launch the complete transform stack:

```bash
tb up transform
```

Logs and health checks follow the standard tradebot service patterns.

## Configuration

See [services/unarchivist/README.md](../../services/unarchivist/README.md) for detailed configuration and algorithm documentation.
