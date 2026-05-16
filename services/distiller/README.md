# Distiller Service

Reads raw BitMEX documents from MongoDB and writes derived collections: OHLCV trade
bins, quote bins, order book snapshots, and reconstructed instrument messages.

## What it does

- Reads `trade`, `quote`, `orderBookL2`, `compositeIndex`, `funding`, and `settlement` collections
- Produces trade bins, quote bins, order book snapshots, and `instrument` messages
- Processes one calendar day at a time, driven by Redis progress markers written by the Clerk service
- All derivations run in parallel; each blocks on its own date walker until the next day is ready

## Derived Collections

| Source | Output |
|---|---|
| `trade` | `tradeBin1m`, `tradeBin5m`, `tradeBin1h`, `tradeBin1d` |
| `quote` | `quoteBin1m`, `quoteBin5m`, `quoteBin1h`, `quoteBin1d` |
| `orderBookL2` | `orderBook10`, `orderBookL2_25` |
| `compositeIndex`, `quote`, `trade`, `funding`, `settlement` | `instrument` |

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `DB_URL` | yes | — | MongoDB connection URL |
| `DB_DATABASE` | yes | — | MongoDB database name |
| `CACHE_URL` | yes | — | Redis connection URL |
| `CACHE_PASS` | yes | — | Redis password |
| `DISTILLER_DISTILLERS` | no | _(all)_ | Comma-separated subset of distillers to run: `quote`, `trade`, `orderbook`, `instrument`, `partials`. Empty or absent means run all. |
