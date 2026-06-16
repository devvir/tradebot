# data dedup

`data dedup` removes ghost-subscription duplicates from raw WS source files and writes sibling `.dedup.csv.gz` outputs. It is scoped to `instrument` and `orderBookL2` — the only tables affected by the ghost-subscription bug.

---

## Why it exists

BitMEX's WebSocket protocol has a ghost-subscription bug where a stale lingering connection briefly re-delivers the same event stream, injecting a burst of duplicate messages into the source file. On days where a clean alternative source exists (e.g. `mtav`), the duplicated source can simply be excluded from `prepare`. On days where the duplicated source is the only available data, `data dedup` can clean it directly.

The expected result is the earliest (primary) stream, with parallel interleaved streams being discarded because they deliver their messages with a lag greater than `threshold`.

---

## Assumptions

1. **Ghost duplicates carry the same `timestamp`** as the original — they are the same BitMEX event delivered by a second lingering connection. `_date_` (collector reception time) differs; `timestamp` (exchange event time) does not.

2. **Legitimate same-millisecond oscillations are protected by the `threshold`, not the key** — a value can change and return to a prior value within the same millisecond (e.g. a price ticking A→B→A). The two A messages carry the *same* exchange `timestamp` and therefore the *same* content key — identical hashes. The content key alone cannot tell such an oscillation from a ghost. What separates them is arrival lag: an oscillation's repeat appears while the clock is still within `threshold` of that timestamp, so it is kept; a ghost's repeat appears after the clock has moved on by more than `threshold`, so it is dropped. This is the whole reason the algorithm needs the clock and cannot dedup on content alone.

3. **Ghost duplicates arrive late in `_date_` order** — the lagging stream delivers the same event after the primary stream has already moved past it. By the time a ghost message appears in the file, the monotonic clock has advanced beyond its timestamp by more than `threshold`.

4. **`threshold` (default 500 ms)** — the measured floor below which legitimate same-content/different-event messages start being clipped. A control run on a ghost-free `mtav` file lost zero messages at `threshold ≥ 500 ms` and only ~150 of ~5 M below it (those legit duplicates clustered at 200–500 ms clock-lag, none beyond). Ghost lags run to seconds, far past 500 ms, so the default removes essentially all ghosts while losing no real data. Raise it for more safety margin; lowering below 500 ms trades a small number of real messages for a few extra benign duplicates.

---

## Algorithm

### Reader

`data dedup` has its own lightweight reader that groups raw CSV lines into messages without validation or timestamp resolution. A line whose first character is not `,` starts a new message; lines starting with `,` are continuation rows. The first line is dropped only when it is a header (starts with `_date_`) — a source that opens straight on data keeps its first message. Messages are emitted in native `_date_` order — the order they appear in the source file.

### Prune

```typescript
prune(source, thresholdMs, stats, timestampIdx)
```

Maintains a **monotonic clock** = max `timestamp` seen so far (in ms). For each message (partials included):

1. Extract `timestamp` from the first row using `timestampIdx` (simple comma-split) and convert to epoch ms with the shared positional `isoToMs` (no `Date.parse`, no JSON parsing).
2. Advance `clock = max(clock, timestampMs)`.
3. Compute the **content key**: all rows joined, `_date_` stripped (everything from the first comma onward). `timestamp` is part of the content key — same BitMEX event = same key. A key longer than `MAX_LITERAL_KEY` (500 B) is replaced by a compact hash of the same content (see below); the choice is purely length-based — `action` is never inspected.
4. **Drop** if: key already seen **and** `timestampMs < clock − threshold`.
5. **Keep** otherwise: record the key in the seen-set (a detached copy — see below).

**Why this direction:** if a message's `timestamp` is more than `threshold` behind the current clock, the primary stream has already moved past that point. A message arriving that late with an already-seen content key is from a lagging parallel stream, not a legitimate re-occurrence.

**Why `timestamp` is in the content key:** two streams delivering the same BitMEX event carry identical `timestamp` values — fixed by the exchange, not the collector — so the same event always collides on the same key. A recurrence at a *different* timestamp is simply a different event with a different key; the same-timestamp oscillation case is the one the `threshold` handles (assumption 2).

**The seen-set is a rotating pair of `Set`s.** Keys go into `cur`; when it reaches the window size (500 000), `cur` becomes `prev` and a fresh `cur` starts. Membership is `cur.has(key) || prev.has(key)`, so a key is remembered for between 500 000 and 1 000 000 later keys, then forgotten. This bounds memory without per-entry eviction. A single `Map` with `keys().next()` eviction was tried and abandoned: deleting the head each time leaves tombstones the iterator must scan past, which collapses throughput once the window fills (measured ~20× slower on `orderBookL2`). Rotation has no such cost — discarding `prev` is one reference drop. The window of ≈500 k keys comfortably covers ghost-sub lag (seconds, ≈ a couple of busy `orderBookL2` minutes) while keeping the heap bounded — the alternative, an unbounded `Set` over a full day, exhausts it.

**Why partials are deduped too:** a partial is a full state snapshot. When a ghost connection re-delivers an old partial, that copy is *stale* — it lacks the thousands of deltas that have since been applied. Keeping the stale partial while the surrounding ghost deltas are dropped would reset state to that old snapshot — the same damage as dropping every delta in between, far worse than the rare chance of clipping a real message. So partials go through the identical clock/threshold test. A legitimate re-`partial` (reconnect) carries a fresh `timestamp`, hence a different content key, and is always kept; only an exact stale duplicate is dropped.

**Why long keys are hashed (by length, not type).** Most messages are a handful of rows, so their joined content is a fine, exact seen-set key. Some are not: an `orderBookL2` full-book *partial* is tens of thousands of rows (~tens of MB joined), and storing those verbatim would waste the heap. So a key over `MAX_LITERAL_KEY` (500 B) is replaced by a 64-bit hash of the same content, computed in a single incremental pass with no `join` — the large string is never materialised or retained, and the key costs a few bytes. The branch is purely length-based: partials qualify because they are large, with no `action`-specific code. 500 B clears every single-row message of both tables (`orderBookL2` ~95–120 B, `instrument` 101 columns ~135–225 B) plus small multi-row messages, so the common case stays an exact literal key and only genuinely large messages hash. Dedup semantics are unchanged (identical content → identical key, literal or hashed; fresh-timestamp reconnect → different key), collision risk is negligible at the working-set size, and a hash (prefixed `\0`) can never collide with a literal key (which starts at the first comma). The hash also caps the set at ~500 MB (≤ 500 B × the 1 M-entry window).

**Why stored keys are detached copies.** This is the fix for the real out-of-memory failure on duplicate-heavy files. `String.prototype.slice` (used to strip `_date_`) returns a V8 `SlicedString` that keeps its *entire parent* alive — and the parent here is the source line, which readline itself hands back as a substring of its multi-KB decode buffer. A literal key left as a slice and stored in the long-lived set would therefore pin that whole decode buffer, and with it *every other line in the buffer — including the dropped duplicates*. The seen-set is bounded to ≤ 1 M keys, but on a 90%-plus duplicate day those keys are smeared across ~16× more input than on a clean day, so they pin tens of thousands of distinct buffers at once and the heap blows up even though the key *count* never changes. (Clean files keep the same key count densely packed in a few buffers, which is why they never hit this.) The fix: before a key enters the set it is copied into a fresh, standalone backing store (a `Buffer` round-trip) that holds no back-reference, so the decode buffers are collected as soon as readline moves on. This copy runs **only on insert** (≈ the kept fraction of messages); the transient lookup key is left as a cheap slice. A hashed key is already detached and is copied harmlessly.

---

## Output

For each input file `YYYYMMDD.<infix>.csv.gz`, writes `YYYYMMDD.<infix>.dedup.csv.gz` in the same folder. Same column order, same CSV encoding, same gzip compression. No rows are added or reordered — only duplicates are removed. Written via `.tmp` → rename.

---

## CLI

```
tools data dedup [path] [flags]

Flags:
  -T, --threshold <ms>    Max lag (ms) behind the clock to treat as a duplicate (default: 500)
  -D, --dry-run           Run the full pipeline but do not write any output files
  --from <date>           Skip files before this date (YYYYMMDD or YYYY-MM-DD)
```

**`path`** is optional; defaults to `$VAULT_DATA_DIR`. Relative paths are joined with `$VAULT_DATA_DIR`. Accepts the same patterns as `data prepare`. Only `instrument` and `orderBookL2` files in the resolved list are processed; everything else is silently skipped.

---

## Relation to `data prepare`

`data prepare` has its own DEDUP step that runs after SORT+MERGE, with per-table rules tuned for the merged, sorted stream. `data dedup` is independent: it operates on a single raw source file in reception order and shares no code with the prepare pipeline.

The intended workflow for a ghost-subscription day with no clean alternative source:

1. `data dedup <source-file>` → produces `<source>.dedup.csv.gz`.
2. `data prepare` targeting the deduped file as the source.

---

## File structure

```
dev/tooling/src/tools/data/
  time.ts                 — common isoToMs / msToIso (shared by prepare and dedup)

  tasks/
    writer.ts             — common WRITE step (shared by prepare and dedup)

  dedup/
    reader.ts             — lightweight reader: raw message grouping, _date_ order
    prune.ts              — monotonic-clock content-key prune (rotating two-set window)
    run.ts                — entry point: discover files, run pipeline, report stats
    types.ts              — PruneStats
```
