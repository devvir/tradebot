# Distiller Service

Reads raw BitMEX documents from MongoDB and writes derived collections: OHLCV trade
bins, quote bins, order book snapshots, and reconstructed instrument messages.

## What it does

- Reads `trade`, `quote`, `orderBookL2`, `compositeIndex`, `funding`, and `settlement` collections
- Produces trade bins, quote bins, order book snapshots, and `instrument` messages
- Resumes from the last processed document on restart (progress tracked in MongoDB via `_id`)
- Runs all derivations in parallel; sleeps 1 hour between cycles

## Derived Collections

| Source | Output |
|---|---|
| `trade` | `tradeBin1m`, `tradeBin5m`, `tradeBin1h`, `tradeBin1d` |
| `quote` | `quoteBin1m`, `quoteBin5m`, `quoteBin1h`, `quoteBin1d` |
| `orderBookL2` | `orderBook10`, `orderBookL2_25` |
| `compositeIndex`, `quote`, `trade`, `funding`, `settlement` | `instrument` |
