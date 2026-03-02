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

## Message Routing

Writer is a shared service — it determines where to persist each message from AMQP headers, not from its own configuration:

- **`table`** — Target MongoDB collection. Reader sets this automatically from the source collection name.
- **`database`** — Target MongoDB database. Reader sets this from `READER_DATABASE`

Reader and Codec are agnostic about headers — Reader attaches routing information and Codec passes it through. Writer interprets `database` and `table` to select the MongoDB destination.

## Configuration

Copy `.env.example` to `.env` and customize.

Key settings:
- `READER_DATABASE` - MongoDB database to read from (required)

See each service's documentation for the full list of available environment variables.
