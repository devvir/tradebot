# Archeologist Module — Technical Reference

## Overview

The Archeologist module fetches historical data from the BitMEX REST API on a polling schedule and stores it in MongoDB. It retrieves trade history, quotes, settlements, funding rates, insurance events, and other reference data—providing a durable baseline that complements real-time WebSocket collection from other modules.

## Architecture

```
BitMEX REST API → History Service → MongoDB bitmex_history
```

1. **History Service** periodically queries the BitMEX REST API for historical data across multiple endpoints: trades, quotes, settlements, funding rates, insurance, composite indices, and chat.
2. Fetched data is stored in MongoDB under the `bitmex_history` database with collections per table.
3. State is tracked per table/symbol pair to avoid re-fetching; polling resumes from the last known start position.

## Purpose & Use Cases

### Baseline Historical Data
- Provides complete historical reference data (trades, quotes, settlements) independent of WebSocket uptime
- Useful for backtesting and analysis without dependency on real-time collection or WebSocket gaps

### Gap Filling
- If real-time collection (Collector/Archivist) has downtime, the Archeologist can retroactively fill missing periods
- Reconciliation: Compare against collected WebSocket data to verify consistency and integrity

### Off-Chain Reference Data
- Captures funding rates, insurance events, composite indices, and chat—data that may not be streamed via WebSocket or not captured by tick-based collectors
- Essential for complete market state reconstruction and on-chain/off-chain data alignment

### Analytics & Reporting
- Supports comprehensive analytics pipelines that need trade history, funding, settlements, and reference data
- Lower-friction alternative to processing millions of individual WebSocket ticks for aggregate analysis

## Data Storage

Historical data is stored in MongoDB:

- **Database**: Configurable via `HISTORY_DATABASE` (default: `bitmex_history`)
- **Collections**: One collection per table (e.g., `trade`, `quote`, `settlement`, `funding`, `insurance`, `compositeIndex`, `chat`)
- **Document Schema**: Each collection follows the BitMEX REST API response schema for that endpoint

## Polling Behavior

### Per-Table State Tracking
- State is maintained per table/symbol pair in MongoDB (loaded at each cycle startup)
- Tracks the `start` position (for paginated endpoints) and exhaustion status
- Between cycles, the exhausted flag is reset so new rows fetched since the last poll will be captured

### Cycle Behavior
1. Load all table/symbol states from MongoDB (last known start position per table/symbol)
2. Fetch fresh symbols list from BitMEX REST API (instruments and indices)
3. For each configured table:
   - For each symbol (or null if table is non-symbol), record first timestamp if new
   - Paginate through results starting from last known position
   - Store documents in MongoDB
   - Mark table/symbol as exhausted when page is empty
4. Wait for the polling interval
5. Reset exhaustion flags and repeat

### Continuous Operation
- Runs indefinitely in a loop with graceful restart on errors
- Suitable for long-term deployment alongside other modules
- Does not consume real-time bandwidth or require WebSocket connectivity

## Configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| `HISTORY_DATABASE` | `bitmex_history` | MongoDB database name |
| `HISTORY_PORT` | Random | Health check/status port |
| `BITMEX_TESTNET` | (empty) | Set to `true` for BitMEX testnet; empty for mainnet |
| `LOG_LEVEL` | `info` | Logging verbosity |

## Error Handling

- **Network failures** to BitMEX API: Logged and retried on next cycle
- **MongoDB persistence**: Standard database error handling; failures logged for manual intervention
- **State consistency**: Verifies first-timestamp consistency between fetches to detect gaps or anomalies
- **Graceful shutdown**: Completes current cycle before exiting
