# Scribe Service

Fetches the historical record from the BitMEX REST API and writes it to the vault service. Runs continuously, catching up from each table's start date and then polling for new rows as they appear.

## What it does

- Collects public BitMEX REST tables: `compositeIndex`, `funding`, `insurance`, `settlement`, `tick`, `trade`, `quote` — the latter two also as `trade.secondary` / `quote.secondary` for the Secondary liquidity pool
- Each table's behaviour is driven entirely by its entry in [settings.ts](src/utils/settings.ts) — server-side `filter` (incl. `pool`), an optional `symbols` resolver (per-symbol subtasks), an optional `keep` row predicate, an optional `from` start floor — so the runner stays generic and names no table
- Paginates each endpoint oldest-first; writes CSV files to vault, organised by table and date
- Tracks per-task progress in Redis (`scribe_<table>_<id>`); on startup, picks up from the cached date, floored by `SCRIBE_START_DATE` and the table's `from`, falling back to a BitMEX probe on first run
- Handles BitMEX's undocumented pagination caps via time-block pagination (see SCRIBE.md)
- Spreads fetches across independent rate-limit buckets — a guest (180/min per IP) plus one authenticated identity per credential — to raise the throughput ceiling to the sum of their refill rates

`trade`/`quote` collection starts at **2026-04-01** (`from`); earlier history is bulk-collected from BitMEX's S3 buckets by the courier service. Pool is selected via `filter: { pool: … }` and encoded in the table name, so there is no `pool` column.

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
