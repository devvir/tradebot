# Registry Service

Maintains ordered, insert-only mappings for symbols and currencies. Assigns a stable integer ID to each entry — IDs never change, entries are never deleted. Used to encode symbol and currency dimensions into deterministic numeric document IDs across all historical data collections.

## What it does

- Stores all known BitMEX symbols and currencies, each with a permanent integer ID
- Assigns the next available ID when a new entry is registered (idempotent — re-registering an existing entry returns its existing ID)
- Writes a JSON snapshot to the bind-mounted `data/` folder on every new registration, making changes visible in git diff
- Bootstraps from the JSON snapshot on startup if the database is empty

## Development

```bash
pnpm install
pnpm build
pnpm test
```

## Configuration

| Variable | Required | Default | Description |
|---|---|---|---|
| `DB_STORE_URL` | yes | — | MongoDB connection string (db-store) |
| `REGISTRY_DATABASE` | no | `tradebot_registry` | MongoDB database name |
| `REGISTRY_PORT` | no | — | Host port mapped to 80 (HTTP server) |
