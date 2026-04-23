# Tardy Service

Downloads the first day of each month of BitMEX WebSocket history from the Tardis free tier and writes it to the vault service. Covers the seven WS-only tables not available from S3 or the BitMEX REST API.

## What it does

- Fetches the first day of each month from the Tardis BitMEX archive (genesis 2019-03-30, so the first downloadable date is 2019-04-01) up to two days ago
- Skips dates where all seven tables are already closed in vault
- Deletes any open vault files before re-downloading them (crash recovery)
- Streams each date from Tardis minute-by-minute (1,440 requests per date), filtering for only the seven needed channels in a single batched request per minute
- Writes to vault as WS messages — same format as the journalist service
- Closes each table's vault file after all 1,440 minutes are processed
- Rechecks for newly eligible dates at UTC midnight each day

## Tables

| Table | Notes |
|---|---|
| `announcement` | Exchange announcements |
| `chat` | Public chat messages |
| `connected` | Connected user/bot counts |
| `instrument` | Instrument state and pricing |
| `liquidation` | Liquidation events |
| `orderBookL2` | Full order book depth |
| `publicNotifications` | Public push notifications |

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `VAULT_URL` | Yes | — | Base URL of the vault service |
| `TARDY_START_DATE` | No | `2019-03-30` | Override the earliest date to fetch (YYYY-MM-DD or YYYYMMDD). Iteration starts from the first first-of-month on or after this date. |

## Development

```bash
pnpm install
pnpm build
pnpm test
```

For technical details, see [docs/services/TARDY.md](../../docs/services/TARDY.md).
