# Quote Generator

Produces `quoteBin1m`, `quoteBin5m`, `quoteBin1h`, `quoteBin1d` from the raw `quote` collection.

Entry point: `distillQuotes(mongo, database)` in [quote.ts](../../../services/distiller/src/generators/quote.ts).

## Why snapshots, not aggregates

Quote bins are **not** OHLCV aggregates. Each bin is a snapshot of the **last-seen bid** and **last-seen ask** within the minute. Bid and ask are picked independently — the bin's `bidPrice` may come from one source document and its `askPrice` from another.

This matches the BitMEX WS `quoteBin*` stream, which represents "the state of the top-of-book at minute end", not a rolled-up aggregate.

## Phase 1 — raw → `quoteBin1m`

Processed in 5-day chunks. Each batch runs an aggregation pipeline (`buildPipeline`):

1. `$match` by timestamp range
2. `$addFields` computes a per-doc `_period` (`"YYYY-MM-DDTHH:MM"`) and two sort keys:
   - `_askKey` = `_id` if the doc has `askPrice`, else `null`
   - `_bidKey` = `_id` if the doc has `bidPrice`, else `null`
3. `$group` by `(period, symbol)`, using `$top` with `sortBy: { _askKey: -1 }` / `{ _bidKey: -1 }` to pick the highest-`_id` doc that actually had each side. MongoDB sorts nulls below numbers, so descending sort naturally skips past docs that lacked the field.
4. `$addFields` nulls out an `ask`/`bid` that came through as null (belt-and-braces in case no doc in the period had that side at all).
5. `$project` reshapes to `{ group, ask, bid }`.

`processBatch` then materialises `QuoteBin` documents, with `_id = max(ask._id, bid._id)` — the highest sequencing id of the two source docs.

### Tip handling

Unlike trades, the quote generator **explicitly excludes** the current tip minute. `findRange` computes `cutoff` by truncating the latest quote's timestamp to its minute start (e.g. `"2014-11-22T16:59:11.784"` → cutoff `"2014-11-22T16:59:00.000000000"`). The aggregation matches `timestamp < cutoff`, so any quote in the current (potentially incomplete) minute is excluded.

### Resume

`findRange` sets `startDay` to the date of the last existing `quoteBin1m` (inclusive — reprocessed, idempotent via duplicate-key-ignore), or the first quote's date on a fresh run.

Idempotency: `insertMany({ ordered: false })` with `ignoreDuplicateKeyErrors` for code 11000. Re-runs produce the same `_id` (= `max(ask._id, bid._id)`), so duplicates are silently skipped.

## Phase 2 — `quoteBin1m` → 5m/1h/1d

Coarse bins are **not** re-aggregated. They are verbatim copies of `quoteBin1m` documents whose timestamp matches a regex pattern:

| Target | Pattern | Intuition |
|---|---|---|
| `quoteBin5m` | `:(00\|05\|10\|...\|55):00.000Z$` | minute divisible by 5 |
| `quoteBin1h` | `:00:00.000Z$` | minute = `00` |
| `quoteBin1d` | `T00:00:00.000Z$` | midnight |

Each target copies up to `COPY_BATCH = 10_000` new documents per run, using `> after` where `after` is the last existing timestamp in the target. Regex match on an indexed-prefix string range is efficient only for `1d` and `1h` (left-anchored); `5m` is necessarily a full scan of the unprocessed range, which is fine at 10k/run.

## Bin fields

```ts
interface QuoteBin {
  _id:       number;       // max(ask._id, bid._id)
  timestamp: string;       // period-end ISO (e.g. "2014-11-22T17:00:00.000Z" for 16:59 period)
  symbol:    string;
  pool:      'Primary';    // constant
  bidPrice?: number;       // omitted if no bid in period
  bidSize?:  number;
  askPrice?: number;       // omitted if no ask in period
  askSize?:  number;
}
```

A bin with neither ask nor bid is **not** written (both sides null means the period had no useful quotes).

## Test coverage ([quote.test.ts](../../../services/distiller/tests/generators/quote.test.ts))

Integration tests against a real MongoDB container, plus unit tests for pure helpers:

Unit:
- `periodToTimestamp` — period string to end-of-minute ISO (incl. midnight rollover, start of day)
- `addDays` — date string arithmetic (month/year boundary, 1-day)

Pipeline (aggregation only):
- last ask + last bid picked per minute
- ask and bid picked independently when from different docs
- `ask` nulled when no doc has `askPrice` (and vice versa)
- multi-symbol grouping
- minute separation

Integration (full `distillQuotes`):
- end-to-end shape and timestamps with ask-from-different-doc-than-bid
- tip minute exclusion
- resume/no-duplication on re-run
- multi-symbol
- skips quotes with neither side
- empty source → no-op
- multi-day span
