# OrderBook Generator

Replays the `orderBookL2` delta stream to produce two change-only top-of-book collections: `orderBook10` (top 10 per side) and `orderBookL2_25` (top 25 per side).

Entry point: `distillOrderBook(mongo, database)` in [orderbook.ts](../../../services/distiller/src/generators/orderbook.ts).

## Why a replay, not an aggregate

`orderBookL2` is a delta stream: `partial` seeds the full book, then `insert`/`update`/`delete` messages mutate individual price levels by `(symbol, id, side)`. The top-of-book at any point is only knowable by replaying the stream in `_id` order; no purely-declarative aggregation can derive it.

## In-memory accumulator

The generator uses `@devvir/bitmex-database`'s `createTable(BitmexTable.OrderBookL2)`. This is a keyed table: `partial` wipes and seeds, `insert`/`update`/`delete` mutate per key (`symbol` + `id` + `side`). After each message, the full current book for the affected symbol is available via `table.view().data`.

`extractTop(table, symbol, N)` filters the view to one symbol, splits by `side`, sorts bids descending (best first) and asks ascending (best first), then slices to the top N. `O(L)` per call where `L` is the total number of resting levels across all symbols — in practice a few thousand.

## Change detection

`topChanged(prev, next)` compares the previous snapshot for a symbol against the current one, element-by-element. A new output document is only written when the top-N actually changed. For a deep book, most per-level updates happen outside the top-N and produce no output — the two output collections compress dramatically against the raw stream.

## Per-output state

Both outputs share one source stream but are independent: they each track their own `lastTop` per symbol, `seenPartial` (whether the initial `partial` has been observed for that symbol), and pending inserts.

Until the initial partial is seen for a symbol, no output is emitted for it. This prevents writing garbage derived from an incomplete book.

## Resume

`getResumeId` picks `min(max(_id))` across both output collections. Resume restarts from `_id = 0` — the accumulator has no persistence, so the full stream up to the resume point must be replayed to rebuild the in-memory book. Output documents are only written when `id > resumeId`; earlier ids are silently skipped.

This means resume cost scales with total stream size, not with time-since-last-run. For a large collection, a full rebuild takes a while, but it's a background batch service so this is acceptable.

## Duplicate-key handling

`insertMany({ ordered: false })` with `catch` on code `11000`. Resume replays may re-compute some output documents; they have the same `_id` as the source message and get dropped as duplicates.

## Batching

Source is read in batches of `BATCH_SIZE = 1_000` with `{ _id: { $gt: lastId } }`. Pending inserts for each output are flushed at the end of every batch.

## Output document shape

```ts
interface StoredOrderBook {
  _id:       number;               // = source orderBookL2 message _id
  symbol:    string;
  bids:      [price, size][];      // best bid first, top-N
  asks:      [price, size][];      // best ask first, top-N
  timestamp: string;               // from source doc
}
```

`_id` deliberately mirrors the source message, so two different messages (from the same source doc into different outputs) will collide across outputs — but they write to different collections, so there is no conflict.

## Test coverage ([orderbook.test.ts](../../../services/distiller/tests/generators/orderbook.test.ts))

All tests are **pure unit tests against the bitmex-database table API** — no MongoDB container. They exercise the two primitives that the generator composes:

`extractTop`:
- partial seeds the book; top-N is correctly extracted
- top-N limits apply to each side independently
- insert adds a level in the correct position
- update mutates size for an existing level
- delete removes a level
- multi-symbol isolation
- top-10 vs top-25 depth slicing (including levels 11–25)

`topChanged`:
- undefined prev → true
- identical → false
- price change → true
- size change → true
- length change → true

The generator's orchestration layer (resume, batching, `seenPartial` gating, duplicate-key handling) is **not** covered by automated tests. It is structurally simple and the main risk is regression in `extractTop`/`topChanged`, which are covered.
