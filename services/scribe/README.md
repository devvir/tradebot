# Historian Service

Fetches the full historical record from the BitMEX REST API and writes it to the vault service. Runs continuously, catching up from the beginning of time and then polling for new rows as they appear.

## What it does

- Iterates a fixed list of public BitMEX REST endpoints (compositeIndex, funding, insurance, settlement)
- Paginates each endpoint oldest-first in blocks of 500 rows
- Writes output as CSV files to vault, organised by table and date
- Derives its resume point from vault on startup — no separate state store
- Handles BitMEX's undocumented pagination caps via time-block pagination (see HISTORIAN.md)

## Development

```bash
pnpm install
pnpm build
pnpm test
```

For technical details, see [docs/services/SCRIBE.md](../../docs/services/SCRIBE.md).
