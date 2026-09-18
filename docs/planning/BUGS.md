# Open bugs

Known defects that are not fixed. One entry each, with **how to check it is still real** — an
entry nobody can re-verify is a rumour, and this file is only worth keeping if every line in it
can be confirmed against the live system in under a minute.

Close an entry by deleting it. A fixed bug leaves a test and a docblock behind; it does not need
a headstone here.

---

## A day-major layout cannot be grouped, so okx builds nothing from 2026-07

**Verified 2026-08-15.**

okx serves trades monthly until 2026-06 and daily after it, and the daily rendering is **day-major**:

```
trades/daily/20260701/QQQ-USDT-SWAP-trades-2026-07-01.zip
trades/daily/20260702/QQQ-USDT-SWAP-trades-2026-07-02.zip
…                                       29 directories, one file each per symbol
```

`group.ts` assumes a partition's files are **contiguous in the sorted walk** and closes a partition
the moment a different id arrives. Day-major spreads one symbol-month across every day directory of
that month, so `okx|perp|QQQ-USDT-SWAP|trades|2026-07` is opened and closed 29 separate times. The
first close emits it with one input; every one after is `contested`, and a contested partition is
never built:

```
ERROR: Partition assembled from two places — not built
  partition: "okx|perp|QQQ-USDT-SWAP|trades|2026-07"
  inputs: 1
  first: "trades/daily/20260729/QQQ-USDT-SWAP-trades-2026-07-29.zip"
```

**Not a duplicate-rendering problem.** `trades/monthly/` stops at `202606` and `trades/daily/` starts
at `202607`, so trucker's cutover is doing exactly what it should and nothing is collected twice.
Only the daily side is affected: in a monthly directory each symbol appears once, so those partitions
are one file, emitted once.

**`scattered` does not cover it.** That trait exists for bitget's two kline layouts, and its contract
says the walk must be **symbol-major** — closing when the walk leaves the symbol. Day-major is the
opposite: every symbol reappears in every day directory, so that signal fires 29 times a month and
closes nothing correctly.

**Proposed fix, not implemented.** The right closing signal for a day-major series is *leaving the
month*: a partition for month M is complete once the walk passes M's last day directory, and day
directories sort in date order. It costs one month of one dataset in memory — roughly 66 symbols ×
31 days — against bitget's "one symbol's files, a few thousand at worst". That makes `scattered` name
what closes it rather than being a boolean:

```ts
scattered?: 'symbol' | 'period';
```

Unchecked: whether okx's other daily datasets — candlesticks, swaprates, the books — share the
layout, which decides whether this is one series or several.

**How to check:**

```sh
ls /storage/tradebot/archives/okx/trades/daily | head        # day directories, not symbols
tb logs stocker | grep 'assembled from two places'
```

### The error appears for a month nobody could have built

okx's collected months stop at **2023-05** — the audit says `21 mo (2021-09 → 2023-05)` — so nothing
should have been looking at 2026-07 at all. Two things put it there:

- **The files are leftovers.** `trades/daily/202607*` was fetched `2026-07-30`, in the symbol-first
  era that also left bybit's 2019 files behind. Trucker never closed those months and never will
  from where it now starts.
- **The readiness gate was asked too late.** It lived inside `settle`, three steps after discovery,
  so files from a month no collector had closed were still walked, grouped and reported on. **Fixed:**
  `buildable()` now asks the collector at discovery, so an open month is never grouped at all —
  whether or not raw for it happens to be on disk.

That ordering is why this looked like a live problem on a venue whose collection ended three years
earlier. With the gate moved, the errors stop; the grouping fault below is still real and still
waiting for okx's daily era to be collected properly.

### The dangerous half is silent

The contested rule refuses a partition **the second time** it is assembled. The first emission is not
contested, so it reaches `settle` and would be built — from one day's file.

Nothing was built here only because `ready()` refused the month. **Once a day-major month is properly
collected and closed, the first emission produces a partition holding 1/29th of its month**, recorded
as built, counted in the rollup, and eligible for cold storage — indistinguishable from a complete
one. That is worse than the visible error and is the reason this is worth fixing before okx's daily
era is collected for real.

**Worked around, not fixed:** `STOCKER_END_MONTH=202606` in the warehouse module keeps stocker below
the cutover. Nothing was built for 2026-07 or later — no partitions, no facts, nothing in cold
storage — so there is nothing to undo when it is fixed.

**Also worth deciding:** whether those 2026-07 leftovers should stay on disk at all. They are raw for
months no collector claims, which is the same shape as the bybit 2019 files, and they are what makes
this bug reachable today.

---

## Most of the vault was built before the completion gate existed

**Verified 2026-08-13.**

Stocker only builds a venue-month once the collector has published it as collected through, and it
records that time as `closedAt` on every partition it writes. Counting the ledger by whether that
field is present:

```
with closedAt:   60,557   built 2026-08-05T18:23 → 2026-08-13
no closedAt:    190,528   built 2026-07-31T08:38 → 2026-08-10
```

**76% of the vault carries no `closedAt`.** Those partitions were built from whatever raw happened
to be on disk, with nothing saying the month was finished — so any of them may be a partial month
recorded as a whole one.

The gate itself works. Tip-bearing records stop *exactly* at each venue's published tip — gate at
`2020-03` against tip `202003`, okx at `2023-05` against `202305`, htx at `2026-06` against
`202606`. Everything past those tips is tipless, and each venue's tipless builds stop about when
its tips file first appears:

| venue | tipless | last tipless build | tips file |
|---|---|---|---|
| htx | 35,967 | 2026-08-04 | 2026-08-08 |
| bybit | 19,534 | 2026-08-10 | 2026-08-11 |
| bitget | 18,811 | 2026-08-05 | 2026-08-11 |
| okx | 11,960 | 2026-08-04 | 2026-08-06 |
| gate | 11,486 | 2026-08-03 | 2026-08-11 |
| kucoin | 10,808 | 2026-08-04 | 2026-08-10 |

So this is historical debt rather than a live hole — but **nothing distinguishes a tipless
partition from a sound one except the absent field**, and both `cold push vault` and `cold evict
archives` treat them identically.

binance was the extreme case and is now gone: 81,962 partitions, 108 months, zero tips ever
published, `@shared/complete/binance.tsv` never created. Its parquet was deleted from the vault and
Mega on 2026-08-13, and its `cold.sqlite` rows and both ledger files were removed with it.

**How to check:** count ledger records with and without `closedAt` under
`$DATA_DIR/vault/@meta/built/*.jsonl`, and compare each venue's highest tip-bearing month against
`$DATA_DIR/@shared/complete/<venue>.tsv`.

**Not fixed pending the ledger move to SQLite.** Deciding what to do about 190,528 partitions —
rebuild, re-verify against raw, or accept and backfill `closedAt` — is much easier to express
against a table than against append-only JSONL, so it waits for that.

---

## The audit's month counts measure cold storage, not what exists

**Verified 2026-08-13.**

The first line of every dashboard cell reads `108 mo (2017-07 → 2026-06)`, and it is derived from
`cold.sqlite` — so it counts **months cold storage holds parts for**, not months of data that
exist. That makes an inventory out of a backup backlog.

The proof is bybit: its vault parts were purged on 2026-08-13 while every partition stayed on disk,
and the column went to `—`. Nothing was lost and the number said everything was.

It should come from the producers: the ledger for the vault, and — the open question — something
equivalent for the archives, which have no ledger and whose tree is 4.9M files to walk. Cold
storage stays the authority for lines two and three, which are about what is backed up, and that is
the one thing it does know.

**How to check:** compare a venue's first-line month count against
`$DATA_DIR/vault/@meta/built/*.<venue>.jsonl`, which knows nothing about backups.

**Not fixed pending the ledger move to SQLite**, since that is where the vault side of the answer
will come from.

---

## Parquet partitions can be rebuilt twice in one sweep, undetected

**Verified 2026-08-10.**

A partition's files are assumed contiguous in the walk: `group.ts` closes a partition the moment
a file with a different id arrives. When that assumption breaks the same id is closed twice in
one sweep, built twice, and **whichever build ran last is what stays on disk** — silently, and
differently on each pass.

Nothing notices, because `settle` never updates the in-memory ledger it was given:

```ts
// scan.ts — sweep()
const built = await ledger.load();   // Map<string, Built>, each carrying builtAt

// scan.ts — settle(), after a successful build
await ledger.record(manifest);       // appends to the file, leaves the map alone
```

So the second build compares against the record as it was **before the sweep**, sees inputs that
differ, and rebuilds. Working as written; the gap is that nothing asks whether *this* sweep
already built it.

Two instances have been found and both are now fixed at their own cause, which is why this is a
detection gap rather than an active corruption:

| instance | why it closed twice | fixed by |
|---|---|---|
| every gate funding partition (756 of 757) | two series shared one partition id | `kind` became a partition attribute |
| `trades\|bybit\|perp\|DOTUSD\|2021-12` | a misfiled raw file sorted after its own partition | the file was removed and excluded |

The second is what it looks like in the ledger — alternating, once per sweep, 26 times:

```
12:09  1 file    45,780 rows      DOTUSDT2021-12-06.csv.gz
13:08  31 files  1,135,668 rows   DOTUSD2021-12-01 … DOTUSD2021-12-31
13:52  1 file    45,780 rows      DOTUSDT2021-12-06.csv.gz
```

**Check whether any partition has ever been built from differing input sets:**

```bash
cd "$STOCKER_VAULT_DIR/@meta/built" && python3 - <<'PY'
import json, collections, glob
seen = collections.defaultdict(set)
for f in glob.glob('*.jsonl'):
    for line in open(f):
        try: d = json.loads(line)
        except: continue
        seen[(f, d['id'])].add(tuple(sorted(i['path'] for i in (d.get('inputs') or []))))
bad = {k: v for k, v in seen.items() if len(v) > 1}
print(f'{len(bad)} partitions built from differing input sets')
for (f, i) in list(bad)[:10]: print('   ', f, i)
PY
```

Zero is the expected result. Anything else is a partition whose contents depend on walk order.

**Proposed fix, not yet implemented.** Update the map after a build — `built.set(manifest.id,
manifest)` — and compare `builtAt` against the sweep's start time. A record written after the
sweep began means this sweep already built the partition, which is a contiguity violation by
definition. Log it rather than throw at first: the two known causes are gone, so anything it
catches is something nobody has seen yet.

Two things to settle while doing it:

- `changed()` and `reopened()` also read that map. Both need to behave against a record written
  seconds ago rather than days.
- Updating the map is arguably a fix and not only an alarm, since it is what makes a second
  build in the same sweep visible at all.

**Not solvable from the filesystem.** "The Parquet already exists, refuse to overwrite" fights a
deliberate decision — `scan.ts` states that disk presence is *not* consulted, because a rebuild
reads raw and never the previous Parquet, and raw is evicted a month at a time. Refusing would
break the ordinary case of a partition becoming more complete as raw arrives. Comparing the
file's mtime against the sweep start would work, but it is the same comparison against a rename
time and a filesystem clock instead of a recorded field.

---

## Bybit's `DATAOLD01USDT` files disagree with their own directory

**Verified 2026-08-10. Latent — nothing is built from it yet.**

Bybit renamed the ticker. The directory carries the new name and the files inside keep the old
one:

```
bybit/trading/DATAOLD01USDT/DATAUSDT2023-12-20.csv.gz     225 files
```

There is **no `trading/DATAUSDT/` directory**, so these are the only copy and they are correctly
placed. This is not the misfiled-file case — nothing is truncated and nothing is duplicated.

The problem is what happens when stocker builds it. The symbol comes from the **directory**, so
the vault will record `symbol=DATAOLD01USDT` while every row inside says `DATAUSDT`. Whichever
way that is resolved should be a decision rather than an accident:

- **Leave it** — the directory is bybit's own current view of the instrument, and the vault
  follows the venue. Costs a symbol whose rows disagree with its path.
- **Map it** — record the vault symbol as `DATAUSDT`. Costs a rename map, which is a new kind of
  per-venue knowledge and grows silently as venues rename more tickers.

**Check whether it has become live:**

```bash
ls "$TRUCKER_DATA_DIR"/bybit/trading/DATAOLD01USDT | head -3
ls -d "$TRUCKER_DATA_DIR"/bybit/trading/DATAUSDT 2>/dev/null || echo 'only copy'
find "$STOCKER_VAULT_DIR" -path '*symbol=DATAOLD01USDT*' -name '*.parquet' | wc -l
```

Zero partitions today. Once that number is non-zero the decision has been made by default.

---

## Gate's spot klines are collected and never normalised

**Verified 2026-08-10.**

Trucker collects `gate/spot/candlesticks_{1d,1h,4h,7d}` — roughly **8,557 files across 26
months** — and stocker has no series that matches them. They sit in the raw tree for ever,
reaching no partition.

The gap is the **market**, not the venue or the table. Gate's perp candlesticks are matched with
the interval captured from the path:

```
futures_(usdt|btc)/candlesticks_(?<interval>[^/]+)/…   → klines, market: perp
spot/deals/…                                           → trades, market: spot
                                                       …and no spot klines entry at all
```

Found by the `cold evict archives` planner, which refuses to evict a month holding raw that never
reached the vault — so this currently blocks eviction of **every gate month**.

Either stocker should model them or trucker should stop collecting them; the point of the
eviction rule is that this gets decided rather than accumulating.

**Check:**

```bash
ls "$TRUCKER_DATA_DIR"/gate/spot/                             # what gate publishes
grep -n "venue: 'gate'" -A2 services/stocker/src/schema/series.ts | grep match:
```

### Possibly transient, on the same run — revisit once stocker settles

The same planner reported smaller counts of gate raw not in the vault, which are **probably not
bugs**: every gate funding partition was deleted on 2026-08-10 for the `kind` fix and stocker was
mid-rebuild when this ran.

```
32  futures_usdt/funding_updates      32  futures_usdt/funding_applies
32  futures_usdt/candlesticks_7d      32  futures_usdt/candlesticks_10s
25  spot/deals                         4  futures_btc/* (same four)
```

Far too small to be structural — the spot klines above are two orders of magnitude larger — and
the perp candlestick regex does capture `7d` and `10s`. Re-run the planner against a settled
vault before treating any of it as real.
