# Vault Service

An HTTP file store for date-partitioned CSV data. Accepts rows over HTTP, serialises them to CSV, and manages the open→closed lifecycle of each file.

## Core Functionality

- **Row ingestion** — accepts JSON rows (single or batch), buffers them in memory, and flushes to a live gzip stream in batches
- **File lifecycle** — files transition from `open` (`.csv.gz.tmp`, gzip stream live) to `closed` (`.csv.gz`, sealed)
- **Binary upload** — accepts pre-built gzip files directly (e.g. from S3 downloads)
- **Streaming read** — streams open and closed files back to callers as NDJSON
- **File listing** — returns a table's files mapped to their open/closed state
- **Health monitoring** — gates inserts on storage health; returns 503 when unhealthy

All data lives under `/data/vault` as `table/yyyy/yyyymmdd.csv.gz.tmp` (open) or `table/yyyy/yyyymmdd.csv.gz` (closed).

## Development

```bash
pnpm install
pnpm build
pnpm test
```

## Configuration

No environment variables — data directory is fixed at `/data/vault`. The HTTP server listens on port 80.

Requires `/data/vault` to be mounted as a writable volume.

For technical details, see [docs/services/VAULT.md](../../docs/services/VAULT.md).
