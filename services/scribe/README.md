# Scribe Service

Fetches the full historical record from the BitMEX REST API and writes it to the vault service. Runs continuously, catching up from the beginning of time and then polling for new rows as they appear.

## What it does

- Iterates a fixed list of public BitMEX REST endpoints (compositeIndex, funding, insurance, settlement)
- Paginates each endpoint oldest-first in blocks of 500 rows
- Writes output as CSV files to vault, organised by table and date
- Tracks per-task progress in Redis (`scribe_<table>_<id>`); on startup, picks up from the cached date, clamped by `SCRIBE_START_DATE`, falling back to a BitMEX probe on first run
- Handles BitMEX's undocumented pagination caps via time-block pagination (see SCRIBE.md)
- Spreads fetches across independent rate-limit buckets — a guest (180/min per IP) plus one authenticated identity per credential — to raise the throughput ceiling to the sum of their refill rates

## Configuration

| Env var | Description |
|---|---|
| `SCRIBE_START_DATE` | Lower bound (`YYYYMMDD`) for the first run; ignored once Redis progress exists. |
| `SCRIBE_IDENTITIES` | Optional `apiKey:apiSecret,apiKey:apiSecret,…` list. Each pair adds a 120/min authenticated bucket on top of the guest bucket. Default empty = guest only. Parsed in the fetch layer, never logged. |

## Development

```bash
pnpm install
pnpm build
pnpm test
```

For technical details, see [docs/services/SCRIBE.md](../../docs/services/SCRIBE.md).
