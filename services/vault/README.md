# Vault Service

An HTTP file store for date-partitioned BitMEX CSV data. It accepts rows over HTTP, writes them to
gzip CSV files, and manages each file's open → closed lifecycle. It is not the Parquet vault.

Deployed by: no module.
How it works: [docs/services/VAULT.md](../../docs/services/VAULT.md).

## Core Functionality

- **Row ingestion**: accepts JSON rows or WS messages (one or a batch), buffers them in memory, and
  appends them to the open file as gzip members
- **File lifecycle**: a file is `open` (`.csv.gz.tmp`, being written) until it is sealed, then
  `closed` (`.csv.gz`, permanent)
- **Upload**: stores a complete pre-built gzip file as a closed file
- **Streaming read**: streams closed files back as NDJSON; open files are not readable
- **Listing and stats**: a table's files with their state, and one file's size and times
- **Health**: refuses rows with `503` while storage is unhealthy, and `429` for a file with too many
  writes pending

Files live under `/data/vault` as `<table>/<yyyy>/<filename>.csv.gz.tmp` (open) or
`<table>/<yyyy>/<filename>.csv.gz` (closed). `<filename>` is the date (`20240101`) or, when a client
tags the file with `?suffix=`, `<date>.<suffix>`.

## Development

```bash
pnpm install
pnpm build
pnpm test
```

## Configuration

- **HTTP API** on port 8000; **health check** on port 3000.
- **`VAULT_COMPRESSION_LEVEL`**: gzip level, an integer from 1 to 9; default 6. Any other value
  fails startup.
- **`LOG_LEVEL`**: log level; default `info`.
- **Data directory**: fixed at `/data/vault`. Mount a writable volume there; the container runs as
  uid 1000, so the volume must be writable by it. `docker/base.yml` mounts no volume, so without
  one the data goes with the container.

`docker/compose.yml` publishes port 8000 on `${VAULT_BIND:-127.0.0.1}:${VAULT_PORT}`; with
`VAULT_PORT` unset, Docker picks the host port.
