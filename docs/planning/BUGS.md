# Open bugs

Known defects that are not fixed. One entry each, with **how to check it is still real** — an
entry nobody can re-verify is a rumour, and this file is only worth keeping if every line in it
can be confirmed against the live system in under a minute.

Close an entry by deleting it. A fixed bug leaves a test and a docblock behind; it does not need
a headstone here.

---

## Bitget: the catalog holds the poorer of two copies of some days

**Counted 2026-10-08**: hauler, passing over files downloaded before the catalog existed, found 652
of bitget's that differ from what the catalog describes. Each was moved aside as `.bak` and the
catalog's copy fetched in its place. In every pair looked at, the file that was already on disk is
the fuller one. Two separate causes, and **neither is understood well enough to fix yet** — what
follows is what was seen, and what was not checked.

### Klines: an era-1 file that is an empty archive, where the era-2 file holds the day

75 files, perp `klines,1m`: seven symbols (ADA, BNB, BTC, DOGE, SOL, XLM, XRP — all `…USDT`) on
eleven days between 2022-01-19 and 2023-01-05. These are era-2 keys dated before era 2 began, which
[BITGET.md](../venues/BITGET.md) already knows about and reads as duplicates of era 1.

Seen:

- The venue serves both for the same day. For `ADAUSDT` 2022-01-19:
  `kline/ADAUSDT/ADAUSDT_UMCBL_1min_20220119.zip`, 66,009 bytes, modified 2022-11-01, which is the
  catalog's entry; and `kline/ADAUSDT/UMCBL/20220119.zip`, 67,274 bytes, modified 2024-07-30, whose
  checksum is the file that was on disk.
- Ten pairs unpacked and compared hold the same candles, time for time and value for value —
  1,440 of them in the one counted. Only the header's case differs, as BITGET.md says.
- **Ten of the 75 era-1 files are 22-byte archives with nothing in them**, and their era-2 copies
  are full-sized. For `ADAUSDT` 2022-04-03 the venue answers 22 bytes at the era-1 path and 64,051
  at the era-2 one. `BNBUSDT` 2022-01-19 and 2022-05-18 are two more.

**Spot `klines,1m` does it too**: 125 files, seven symbols (AAVE, ADA, BNB, BTC, DOGE, PYUSD, QKC —
all `…USDT`) on 43 days between 2022-01-19 and 2023-10-31. In the one pair opened, the file that was
on disk was generated 2024-07-30 and its replacement 2022-11-08, as on the futures line. None of the
replacements checked is an empty archive. Nothing else about them was looked at — the `QKCUSDT` and
`PYUSDUSDT` files are all in 2023, which may be another matter.

Not checked: how many era-1 kline files across the catalog are empty archives, and whether each has
an era-2 copy. The days BITGET.md counts as "the only copy" may have been found by an era-1 key
being absent, which an empty one is not.

**How to check:**
`curl -sI -A Mozilla/5.0 https://img.bitgetimg.com/online/kline/ADAUSDT/ADAUSDT_UMCBL_1min_20220403.zip`
answers `content-length: 22`, and the same for `…/kline/ADAUSDT/UMCBL/20220403.zip` answers 64051.

### Perp depth: a series reading a folder that holds a fragment

295 files, perp `quotes`: `ZKUSDT` (151) and `TAIKOUSDT` (144). The catalog reads each through a
`url_symbol` — `ZKSYNCUSDT` from 2024-07-27 and `TKOUSDT` from 2024-09-09 — and the files that were
on disk came from the folder under the plain symbol. Every replacement is far smaller.

Seen, for `ZKUSDT` 2024-07-27:

- `depth/ZKSYNCUSDT/2/20240727.zip`, the catalog's entry: 4,643 bytes, one sheet named
  `20240727_7.xlsx`, **3 rows**.
- `depth/ZKUSDT/2/20240727.zip`: 129,133 bytes, one sheet named `20240727_2.xlsx`, **4,317 rows**,
  and the size of the file that was on disk.
- Both quote around 0.16 on that day.

For `TAIKOUSDT` only sizes were compared — 2024-11-16 is 46,715 bytes now and was 246,688 — and the
venue was not asked.

Not checked: whether `depth/ZKUSDT/2/` is one instrument for its whole range or an earlier holder of
the ticker; the range each folder covers; and whether this is the futures-line counterpart of *Depth
can be spelled differently from the rest of an instrument* in BITGET.md, which was measured on spot.
A larger file is not proof of the right file.

**How to check:** the same request for `depth/ZKSYNCUSDT/2/20240727.zip` and
`depth/ZKUSDT/2/20240727.zip` answers 4643 and 129133.

**Spot `quotes` too**: 157 files. Not opened — only counted.

### What it costs meanwhile

A hauler pass that meets one of these on disk replaces the fuller copy with the catalog's, keeping
the old one as `.bak`. Restoring a `.bak` is undone by the next pass for as long as the catalog
describes the other copy.

Fixing it belongs to the bitget seed, and to nothing quicker: bitget reuses tickers, moves folders
and has changed its paths more than once, so every pairing above is to be confirmed against the
venue before the seed is touched.

---

## Known data issues (unconfirmed, owner to review)

Each entry below is an observation: what the code or the venue does today, and where to see it. None
is confirmed as a defect yet; whether each is one is the owner's to decide. Each place is named by
its function as well as its line, so it can be found when the lines move.

### Gate: 1,468 spot-shaped files under `futures_usdt/trades/202107/`, 85 of them excluded

Seen:

- The prefix holds 1,643 keys: 130 four-column futures files, 1,468 five-column spot files and 45
  empty or near-empty ones ([GATE.md](../venues/GATE.md#2021-07-spot-data-at-the-futures-url)).
- Migration `001-core` excludes 85 of the spot files by exact path
  (`SPOT_AT_A_FUTURES_URL`, `services/prospector/src/database/migrations/001-core.ts:114`). Its
  docblock says they are 85 of the spot-shaped files in that month, not all of them.
- gate's `accepts` (`services/prospector/src/adapters/gate.ts:29-40`) refuses none of the other
  1,383: nothing in it looks at `202107` or at the column count.
- Stocker refuses a positional file wider than its series declares
  (`assertDeclaredWidth`, `services/stocker/src/build/shared.ts:255`; in a batch, `batchFrom`,
  `services/stocker/src/build/batch.ts:202`). A perp trade partition holding one of the 1,383 fails
  to build, naming the file, instead of writing spot sizes as signed futures sizes.

Not checked: how many of the 1,383 the live catalog holds, and so how many perp partitions of 2021-07
cannot be stocked.

**How to check:** `grep -c "futures_usdt/trades/202107/" services/prospector/src/database/migrations/001-core.ts`
answers 85; listing `futures_usdt/trades/202107/` on the bucket in GATE.md answers 1,643 keys over
two pages.

### Stocker: a withdrawn file left on disk stops its partition matching the catalog

Seen:

- The catalog counts a file that is not confirmed in a partition's `withdrawn`, never in its `files`
  or `bytes` (`count`, `services/prospector/src/catalog/cache/partitions.ts:179-183`).
- Stocker keeps a partition's `files` and `bytes` from the partitions endpoint and drops its
  `withdrawn` (`listPartitions`, `services/stocker/src/catalog.ts:47-50`), and counts every canonical name under the partition's
  month directories as one of its files (`filesOf`, `services/stocker/src/disk.ts:23`).
- A partition is built only where that count and byte sum equal the catalog's `files` and `bytes`
  (`matches`, `services/stocker/src/disk.ts:69-71`; used in `decide`,
  `services/stocker/src/decide.ts:148`, and for a neighbour's edge in `edgesOnDisk`, `:292`).
- Nothing deletes or renames a file on disk once the venue withdraws it.

So a downloaded file that the venue then withdraws stays under its canonical name, the disk holds one
file more than the catalog says, and the partition, and any neighbour reading its edge, never matches
again. A partition stocked before the withdrawal keeps that file's rows in the vault.

**How to check:** a partition the catalog answers with `withdrawn` above 0, whose withdrawn file was
downloaded before the venue withdrew it, is passed over by every sweep (`decide.ts:148`) and never
built.

### Stocker: rows that share a timestamp have no fixed order

Seen:

- A partition is sorted by `ts`, or `ts, sequence` for a table with a sequence, and nothing else
  (`orderOf`, `services/stocker/src/build/shared.ts:242-243`).
- Stocker's DuckDB instance is opened with `preserve_insertion_order=false`
  (`services/stocker/src/db.ts:52`), so its parallel sort does not keep the order the source gave
  rows with equal keys.

So trades that share a millisecond can come out in a different order from one build of the same
partition to the next, and a replay of the vault is not byte-for-byte repeatable within a timestamp.

**How to check:** build one month that holds many trades per timestamp twice with more than one
thread, and compare the order of `tradeId` within each `ts`.

### Stocker: a side's revision ignores the neighbour era's series version

Seen:

- A partition's revision folds in the versions of the series that hold for its own month
  (`revisionOf`, `services/stocker/src/vault.ts:95`; `versionsOf`, `services/stocker/src/versions.ts:40`),
  and for each edge only the neighbour partition's catalog version (`vault.ts:102`).
- The rows of an edge are read by the series of the neighbour file's own month
  (`seriesFor`, `services/stocker/src/schema/series.ts:950`).

So at an era cut, such as htx's `HTX_CUT` of `2026-02` on datasets that spill `back`
(`services/stocker/src/schema/series.ts:143`), the side of January 2026 is written by the series from
2026-02 on, and giving that series a new `version` does not move January's revision. Today the only
series with a `version` is bybit's perp klines (`schema/series.ts:468`), which has no era cut, so no
stored revision is affected yet.

**How to check:** `grep -n "version:" services/stocker/src/schema/series.ts` lists the versioned
series; none of them sits on either side of an era cut.

### Prospector: one URL shape can be reported under two variants, and the registry keys omit the variant

Seen:

- A pattern is unique per `(venue_id, slice_id, pattern)` (table `pattern`,
  `services/prospector/src/database/schema.ts:397`), and two slices can differ by variant alone.
- The in-memory keys for a shape and a series leave the variant out (`identity` and `patternKey`,
  `services/prospector/src/catalog/series.ts:1094-1109`), and `patternIdOf` looks a shape up by that
  key before it reads the slice (`series.ts:1248`).

So a shape reported under a second variant is filed under the slice of the first. No seed holds one
pattern under two variants of one market and dataset today.

**How to check:** in each `services/prospector/src/database/migrations/seeds/*/pattern.csv`, no two
rows share `market`, `dataset` and `pattern` with different `variant`s.

### Router: the source is acked before the broker has the copy

Seen:

- The router acks a message once its publish to every destination has returned (`route` and
  `handleDelivery`, `services/router/src/consumer.ts:131` and `:193`).
- A publish returns once the message is written to the channel: the publisher's channel is a plain
  channel (`createChannel`, `packages/rabbitmq/src/connection.ts:87-88`), not a confirm channel, and
  nothing is published with the mandatory flag.

So a copy lost after its publish returned, because the publisher's connection drops before the broker
has it or because its destination exchange routes it to no queue, is not retried: its source is acked
by then. The same holds for a retry copy and a dead letter. Delivery is at most once on those faults.

**How to check:** `grep -rn createConfirmChannel packages/rabbitmq/src` finds nothing.

### Prospector: a preamble backfill cut short loses what it found, and its series is not walked again

Seen:

- The backfill asks each period with `fetchHead(adapter, url(...))` and no stop signal (`backfill`,
  `services/prospector/src/backfill.ts:72`), and `preamble` itself takes none
  (`services/prospector/src/preamble.ts:31`). A `Retry-After` within the venue's ceiling is waited
  out with that signal (`obey` and `waitOut`, `services/prospector/src/http.ts:391-408` and `:425`),
  so a pause does not end the wait; the backfill goes on once it is over.
- Every file the backfill finds is kept in `found` and written by one `putFiles` after its loop
  (`backfill.ts:113`). A `fetchHead` that throws (a `StoodDown` for a `Retry-After` past the ceiling,
  or its 5 attempts spent, `http.ts:224-258`) leaves the loop before that, and none of what was
  found is written.
- The series row and its tip are written before the backfill runs (`floor` and `recordSeries`,
  `preamble.ts:178-180`), so the series is `active` from then. A later preamble skips an instrument
  with an `active` series (`preamble.ts:116`) and walks only the series this pass opened
  (`walking`, `preamble.ts:247`), and generation does not ask below a tip.

So a backfill that ends early leaves its series' history below the floor uncatalogued, and nothing
seen here asks for it again. Not checked: whether a later walk of the venue reaches those files.

**How to check:** read `backfill` in `services/prospector/src/backfill.ts`: the only write is the
`putFiles` after the loop, and `fetchHead` is called with two arguments.
