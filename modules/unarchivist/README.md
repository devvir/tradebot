# Unarchivist Module

Reads stored documents from MongoDB, optionally transforms them via Codec, and writes to another collection.

## Components

- **Reader** - Scans MongoDB collections and publishes documents to RabbitMQ
- **Codec** - Transforms messages (optional decoding and decompression)
- **Writer** - Persists transformed messages to MongoDB collections
- **RabbitMQ** - Message broker for Reader → Codec → Writer pipeline
- **MongoDB** - Source and destination database for documents

## Quick Start

Start the module:
```bash
tb up unarchivist
```

Build images and start:
```bash
tb up unarchivist --build
```

Stop the module:
```bash
tb down unarchivist
```

View logs:
```bash
tb logs unarchivist
```

## Configuration

Copy `.env.example` to `.env` and customize:
- `READER_DATABASE` - MongoDB database to read from (required)
- `WRITER_DATABASE` - MongoDB database to write to (required)
- `CODEC_STRATEGY` - Transformation modes: `encode`, `binary`, `encode,binary`, `decode`, or empty for pass-through (optional)
- Other configuration in `.env.example` with defaults documented
