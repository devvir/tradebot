# MongoDB Compression Strategy Analysis

This folder tracks compression experiments and their impact on storage size.

## Goal

Reduce MongoDB storage footprint for BitMEX market data without losing information. Data is long-term historic data used for WebSocket replay.

## Methodology

1. **Baseline** (`baseline-storage-analysis.md`) - Original uncompressed JSON data
2. **Strategy Implementations** - Apply compression techniques
3. **Re-analysis** - Run stats script again with new strategy
4. **Comparison** - Calculate improvement: `(original - compressed) / original * 100`

## Why Separate Partial vs Non-Partial?

BitMEX sends two message types with very different characteristics:

- **Partial messages** (action="partial"): Large snapshots on subscription, can be kilobytes
- **Non-partial** (insert/update/delete): Incremental updates, typically much smaller

Separating them shows:
- Which type benefits most from compression
- Whether compression overhead is worth it for small messages
- True per-message storage cost

## Running Analysis

```bash
# Generate (or regenerate) baseline stats
npx ts-node scripts/mongodb-stats.ts

# Output: baseline-storage-analysis.md
```

For each new strategy, re-run the script and note results in the markdown file.

## Potential Compression Strategies

### 1. Message-Level Compression
- **gzip** individual BSON documents before storage
- Pros: Independent per-message, standard
- Cons: Overhead on small documents

### 2. Schema Optimization
- **Remove redundant fields** across messages
- **Encode enums** as numbers instead of strings
- **Truncate numeric precision** where possible
- Pros: No decompression needed for queries
- Cons: Schema changes, data loss risk

### 3. Time-Series Optimization
- **Delta encoding** for numeric fields
- **Truncate timestamps** to seconds if hour-level granularity is sufficient
- **Store only diffs** instead of full instrument state for incremental updates
- Pros: Very effective for sequential data
- Cons: Requires replay logic

### 4. Hybrid Approach
- Store full partial messages uncompressed (frequent queries)
- Compress/optimize incremental updates (volume data)
- Time-based archival (compress old data differently)

## Example Table Format

```
| Collection | Strategy | Date | Partial Avg | Non-Partial Avg | Index Size | Savings |
|---|---|---|---|---|---|---|
| instrument | Baseline (JSON) | 2026-02-19 | 8.5 KB | 1.2 KB | 256 KB | - |
| instrument | gzip (v1) | 2026-02-20 | 4.2 KB | 0.9 KB | 256 KB | 42% |
| instrument | Schema optimized | 2026-02-21 | 6.1 KB | 0.8 KB | 192 KB | 35% |
```

## Storage Context

See `baseline-storage-analysis.md` for current storage breakdown by collection.
