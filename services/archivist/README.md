# Archivist Service

Data archival and deduplication service that consumes market data from RabbitMQ, deduplicates records, and persists them to MongoDB for long-term storage and analysis.

## Features

- Consumes data from RabbitMQ queue
- Automatic deduplication of market records
- Batch processing for efficient database writes
- MongoDB persistence with configurable collection mapping
- Health check endpoint for monitoring
- Configurable batch size and timeout
