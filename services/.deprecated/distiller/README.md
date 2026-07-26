# Distiller Service

Reads raw BitMEX documents from MongoDB and writes derived collections: order book
snapshots, reconstructed instrument messages, and per-table daily snapshots.

## What it does

- Reads `trade`, `quote`, `orderBookL2`, `compositeIndex`, `funding`, and `settlement` collections
- Produces order book snapshots, `instrument` messages, and `_partials_` daily snapshots
- All derivations run in parallel

OHLCV bins are not produced here — `scribe` collects them directly from BitMEX's
`/trade|quote/bucketed` endpoints.

## Derived Collections

| Source | Output |
|---|---|
| `orderBookL2` | `orderBook10`, `orderBookL2_25` |
| `compositeIndex`, `quote`, `trade`, `funding`, `settlement` | `instrument` |

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `DB_URL` | yes | — | MongoDB connection URL |
| `DB_DATABASE` | yes | — | MongoDB database name |
| `CACHE_URL` | yes | — | Redis connection URL |
| `CACHE_PASS` | yes | — | Redis password |
| `DISTILLER_DISTILLERS` | no | _(all)_ | Comma-separated subset of distillers to run: `orderbook`, `instrument`, `partials`. Empty or absent means run all. |
