# Rearchivist Module

Reads stored raw messages from MongoDB, compresses them using Codec, and writes to the archives collection.

## Components

- **Reader** - Scans MongoDB collections in the Collector database and publishes to RabbitMQ
- **Codec** - Compresses messages
- **Writer** - Persists compressed messages to MongoDB's archive database
- **Router** - Defines the pipeline messages flow through
- **RabbitMQ** - Message broker for Reader → Codec → Writer pipeline
- **MongoDB** - Source and destination database for documents

## Quick Start

```bash
tb up rearchivist
tb up rearchivist --build
tb down rearchivist
tb logs rearchivist
```

## Message Routing

Data flows through the pipeline via routing key transformations:

```
Reader  → topic:reader  (routingKey = "message.{table}")
Router  → topic:codec.in (routingKey = "compress.{table}")
Codec   → topic:codec.out (routingKey = "compress.{table}")
Router  → topic:writer  (routingKey = "archive.{table}")
Writer  → MongoDB archives database, collection named after the table
```

## Configuration

Copy `.env.example` to `.env` and customize.

Key settings:
- `READER_DATABASE` - MongoDB database to read from (required)

See each service's documentation for the full list of available environment variables.
