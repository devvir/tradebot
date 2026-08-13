# cold audit

`cold audit [origin]` checks that cold storage is what the record says it is, and reports every place they differ. With no origin it checks them all.

**Everything else in this family trusts `cold.sqlite`.** `push` decides what to pack from it, `evict` decides what may be *deleted* from it, and neither can afford to re-derive the world on every run. This is where that trust is earned back.

**Read-only, always.** It changes nothing and repairs nothing — safe to run against a live push. What to do about a finding is a decision, and decisions belong to the commands that ask first.

---

## The order of the questions

**First: is what we believe about Mega true?** An object we cannot account for, or a part whose object is not the one we recorded, is a failure of the record itself — and the record is what two other commands act on. These are problems.

**Then: what is still to do, and what looks odd.** Coverage, backlog, and the things with both an innocent and a guilty explanation.

The output follows that order and is meant to be read by a person: a summary that fits on a screen, then anything wrong, in full.

---

## What it checks

| | severity | |
|---|---|---|
| a part is recorded as backed up and **Mega holds nothing** | problem | the record claims a backup that is not there |
| **the size disagrees** with what its members imply | problem | the object is not the one those members describe |
| **the handle changed** | problem | same path, different object — it was replaced |
| an object in Mega that **no part describes** | problem | nothing can say what is inside it |
| an object a **replan orphaned**, not yet swept | worth a look | superseded on purpose, and already recorded for removal |
| a staged tar and a Mega object of the **same name, different size** | problem | two different tars, and the record cannot say which is right |
| a **gap** in a venue's month range | worth a look | cold storage fills oldest first, so a hole is the shape of a skipped month |
| a file **held in more than one part** | worth a look | ordinary after a rebuild; a runaway count is a replanning loop |
| a staged tar for a part **already in Mega** | worth a look | space that should have come back |
| a part in Mega with **no handle recorded** | worth a look | a same-size replacement could never be detected for it |
| a **replacement outstanding** | worth a look | a newer tar was planned and has not landed |

### Sizes are computed, never remembered

The check that matters most costs nothing to make exact. A member list predicts a tar's byte size precisely — 512-byte headers, content padded to 512, a long-name header for any path past 100 bytes, two zero blocks, then the 10,240-byte blocking factor. So the recorded members are compared against Mega's listing **without downloading anything**, and a match proves the object is the one those members describe.

Comparing against a *remembered* size would only prove the record agrees with itself.

### Findings are named, not counted

An object is reported one line each, with what it holds and how big it is. A count answers nothing anyone can act on: *which* month, *how* big, and whether Mega still reports the size the record implies are the questions, and every one of them is per object.

Ordinary backlog is not a finding at all: what is planned and what is in Mega are two of the three lines of every dashboard cell, per venue and per tree.

**Every check reads only its own origin.** The `superseded` table is keyed by remote path with no origin of its own, so an unscoped read showed one tree's outstanding replacements while auditing the other — the same count in both blocks, for objects the second tree had never had.

### The handle is what makes replacement visible

A size can coincide; Mega's handle identifies the stored object independently of its path. It is recorded when an upload is confirmed, so a later run can tell "the same object is still there" from "something else now occupies that name".

**Writing to a path in Mega creates a new node with a new handle**, so a handle that has not moved is strong evidence the bytes have not either — stronger than the size comparison, which a coincidence can satisfy.

A part confirmed without a handle is reported. That is a **bug to fix, not a state to design around**: the path is known, so the handle can be fetched from Mega and written back, once. As of 2026-08-13 no part is in that state — 343 archives and 223 vault parts, all with handles — so the finding is a guard rather than a live condition.

### Verifying against the members is a once-per-object question

The size comparison asks *is this the tar those members describe*. The handle asks *is this still the object we confirmed*. They are different questions, and only the first needs asking more than once — after an object has been proved to match its members, a stable handle carries that proof forward for ever.

So this is a genuine candidate for caching in `cold.sqlite`: record that part *P* was verified while holding handle *H*, and skip recomputing the predicted size while the handle is unchanged. **Not done**, because recomputing it for every part costs 304ms measured, and that is not yet worth a cache and the ways a cache can be wrong.

### `mega-find` cannot replace `mega-ls`, and the listing is not why the audit is slow

`mega-find` looks better suited on paper — full paths instead of `dir:` headers to track, `--type=f` filtering folders server-side, 223 lines against 288, `--show-handles` all the same. It is unusable for one reason:

```
mega-ls    ----  1  337920  10Aug2026 09:01:11 H:dmM1kbZb 201807.p01.tar
mega-find  /Tradebot/vault/bitget/2018/201807.p01.tar <H:dmM1kbZb> (330.00 KB)
```

**It rounds.** `330.00 KB` cannot be compared against a byte-exact prediction. A handle-only audit using it would work — see above — but would leave a handle-less part unverified and would trade an independent signal for a derived one.

**And there is nothing to gain.** Both commands return in **0.02–0.03 seconds**: mega-cmd's server answers from memory and there is no network round trip. The listing has been assumed to be the slow part of a run and measured not to be — the local costs are the vault walk (3.2s over 140,000 files) and reading what the services built (1.2s). Anyone optimising this should re-profile rather than inherit that assumption.

---

## What the output looks like

Every section is the same shape — a title, a line saying what it is about, and a table. The first is the dashboard: **one row per venue, one column per tree**.

```
COLD STORAGE  every tree, by venue

┌─────────┬─────────────────────────────┬─────────────────────────────┐
│ Venue   │ Vault                       │ Archives                    │
├─────────┼─────────────────────────────┼─────────────────────────────┤
│ binance │ —                           │ 0 mo                        │
│         │                             │ 102,850 files (295.8GB)     │
│         │                             │ nothing backed up           │
├─────────┼─────────────────────────────┼─────────────────────────────┤
│ bitget  │ 40 mo (2018-07 → 2021-10)   │ 42 mo (2018-07 → 2021-12)   │
│         │ 2,189 partitions (3.8GB)    │ 681,777 files (158.6GB)     │
│         │ 40 mo backed up (3.8GB)     │ 41 mo backed up (6.2GB)     │
├─────────┼─────────────────────────────┼─────────────────────────────┤
│ bybit   │ 49 mo (2020-01 → 2024-01)   │ 61 mo (2020-01 → 2025-01)   │
│         │ 15,762 partitions (216.3GB) │ 443,814 files (1.3TB)       │
│         │ nothing backed up           │ 61.2 mo backed up (790.3GB) │
├─────────┴─────────────────────────────┴─────────────────────────────┤
│                                                                     │
├─────────┬─────────────────────────────┬─────────────────────────────┤
│ all     │ 144 mo                      │ 158 mo                      │
│         │ 125,539 partitions          │ 3,696,839 files             │
│         │ 95 mo backed up (109.3GB)   │ 157.2 mo backed up (1.0TB)  │
└─────────┴─────────────────────────────┴─────────────────────────────┘
```

**A venue's trees are two halves of one question — is this venue safe — so they belong side by side.** A column per data point spread one venue's answer across six columns and two tables a screen apart, and comparing its vault against its archives meant holding one set of numbers in your head while reading the other. REST and websocket arrive as two more columns rather than two more tables.

**Three lines per cell, in the order the questions come in.** How far does this go, how big is it, and how much of it would survive this disk dying.

**The first two lines are about the data; the third is about cold storage.** That separation is the point. Reading all three off the `part` rows meant a venue with nothing backed up had no rows to fold and rendered as a single dash — so *there is nothing here* and *none of this is backed up* looked identical, on the one screen that exists to tell them apart. bybit showed a dash over 15,762 partitions across 49 months.

So the months come from the **producer** — the collector's closed months, stocker's built partitions — and the count and size from **what is actually there**. Cold storage is only asked the last question, which is the only one it can answer.

**What is there is on disk plus evicted, never one or the other.** Counting only local makes a venue shrink as it is backed up and cleaned, which is backwards; counting only cold storage misses everything not yet packed. The two sets are disjoint by construction — an evicted file is one that was deleted locally — so adding them is the venue's true size. That is what the [eviction record](COLD-EVICT.md#what-was-reclaimed-is-recorded) exists for, and until a tree has been evicted through it, that tree's total is short by whatever was reclaimed before.

**The vault counts partitions and the archives count files, which is the same quantity.** A partition is exactly one Parquet file; an archive member is one `.zip` or `.csv.gz`. Only the noun changes, per origin.

**A part is never in the cell.** It is cold storage's own packing unit and says nothing about how much a venue holds — leading with it put the real quantity in a parenthesis, and rendered nothing at all for a venue with no parts yet. Where a part is the subject — a gap, a tar missing from Mega — the findings say so in parts, which is where the unit belongs.

**Size is last on both lines that carry one**, so the two land in roughly the same place and a glance down the cell compares them without reading either. Bytes first put the number this is really about — how much is safe — beside a file count on the line below it.

**Backed-up months carry one decimal; the first line never does.** A partially uploaded month is neither in nor out, and rounding it either way is a lie in a table whose whole job is saying where things stand. Each month contributes the share of its parts that have landed, so `16.3` reads as "sixteen months and a bit of another" — a signal that something is mid-flight, not a measurement to act on.

**Month counts add across venues; the months themselves do not.** Seven venues each holding `2020-03` are seven venue-months of data and one calendar month, and a totals row built by unioning them printed `108 mo` under a column adding to 252.

**One shape for every state, and the colour carries the verdict.** `all backed up` beside `41 backed up` was two formats to learn, and its unit was redundant when the numbers matched and misleading when they did not — `all` meant every *part*, which reads as every *month*. Now every cell says `N mo backed up (size)`, green when nothing is outstanding and yellow when something is, so the comparison against the first line needs no arithmetic.

Zero keeps its words: **`nothing backed up`, in red**. `0 mo backed up (0B)` is easy to skim past, and that is the state that most deserves not to be.

**The vault's month count turns yellow when it trails the archives'.** A vault month exists because an archives month was complete, so the two should meet; where the vault's is short, whole finished months have never been normalised. It is the only comparison between two cells of a row that means anything, and it only runs in that direction, since the vault cannot cover a month its source does not. Yellow rather than red because it is a backlog, not a fault, and the number it is short of is already on the same line one column over. The totals row stays dim: totals carry no verdict, the same rule the backed-up line follows.

**Which months, not how many.** A venue short by one because its newest month cannot be built yet and a venue short by one because a month in the middle never built are the same number and different situations, so the sets are compared rather than the counts.

**A spilling venue is green and starred at one month short.** Where every one of a venue's series keeps a month's tail in the next month's first bucket — bitget, whose buckets cut at 16:00 UTC — its newest closed month can never be normalised, because the day that completes it belongs to a month the collector has not closed. That venue sits exactly one month behind its archives for as long as that month is the tip, which under the rule above would be yellow for ever, warning about a state nobody can act on. So the count is green with a `*`, and a footnote under the table says why. Only the newest month is ever excused; anything older is outstanding whatever the venue's buckets do.

**The trait is stated, not inferred.** Whether a venue spills is a property of its series, and what a series is has no business being known in `cold` — so stocker records it as a `spills` fact against the venue and the audit reads it like anything else. A venue where only *some* series spill is deliberately not stated: the month still builds, just from fewer series, so nothing here sees a shortfall to explain.

**The heading row and the venue column are coloured, not just bold.** A cell holds three lines of its own, so a page of this is a lot of text at one weight; the two coloured edges frame the grid rather than decorating it. The totals get a blank spanned row above them, because every row already has a border and a border alone cannot say "and now, everything".

**One shape, because the value is the sameness.** This is the command run to find out where things stand — often daily through a backfill — and a reader who has learned to skim one section should not have to learn the next. It shares its table style with [`data status`](DATA-STATUS.md), so the two look like the same tool.

Findings are grouped by weight rather than listed flat, because a real problem should not have to be found among thirty routine lines:

- **PROBLEMS · &lt;tree&gt;** — cold storage does not match the record. Needs an answer.
- **WORTH A LOOK · &lt;tree&gt;** — has an innocent explanation and a guilty one.

**Findings stay per tree while the dashboard spans them all.** A finding names a part and never says which tree it belongs to, and `202110.p01.tar` exists under both — so the tree is in the heading. Ordinary backlog is not a finding at all any more; the dashboard carries it.

Long lists are cut inside the table, with the remainder as a final dimmed row rather than a line after it — the place just below a long list is exactly where a reader stops looking carefully.

A clean run says so in one line. Anything else ends with a count and a pointer upward.

---

## Reclaim — which side is holding eviction back

The last section answers a different question from the rest, and the only one with an action attached:

```
RECLAIM  archives — uploading a side frees the raw it holds back

┌─────────┬────────────────┬──────────────────┬─────────────────────┐
│ Venue   │      Evictable │ Waiting on vault │ Waiting on archives │
├─────────┼────────────────┼──────────────────┼─────────────────────┤
│ bybit   │              — │   58 mo  646.8GB │       4 mo  321.6GB │
│ binance │              — │                — │    58 mo  unplanned │
│ bitget  │   36 mo  1.5GB │                — │         4 mo  3.4GB │
│ gate    │   26 mo  1.8GB │                — │      17 mo  249.2MB │
│ htx     │  5 mo  149.4GB │                — │                   — │
│ okx     │  21 mo  79.1GB │                — │     6 mo  unplanned │
│ all     │ 90 mo  236.9GB │   58 mo  646.8GB │      89 mo  325.2GB │
└─────────┴────────────────┴──────────────────┴─────────────────────┘
```

**Raw is reclaimable only once both ends are backed up** — the raw itself, and the vault month it became. Either one missing blocks the month, so "how much is in cold storage" is the wrong question and "which of the two is behind" is the right one.

| column | meaning |
|---|---|
| `Evictable` | both ends are safe; `cold evict` can take this raw now |
| `Waiting on vault` | the raw is backed up, its vault month is not — **uploading those vault months frees this much disk** |
| `Waiting on <source>` | the vault month is safe, the raw is not backed up, so the raw still cannot go |

**Rows are sorted by the priority column**, so the venue whose vault uploads free the most disk is always first. On a slow uplink that ordering is the whole decision.

**Every figure is the size of the raw**, never of the vault, because raw is what eviction frees and the two are not the same size — Parquet is a fraction of the zips it was built from. One rule across all three columns, so the numbers can be added up.

**`unplanned` is not zero.** A month no part describes weighs nothing in the record and can weigh hundreds of gigabytes on disk — binance shows 58 such months against 297 GB of raw. Printing `0B` would read as "nothing to gain here", which is the opposite of the truth. An audit reads the record and never walks the source tree, so it says what it cannot weigh instead of guessing.

A month counts as backed up only when **every** part of it is in Mega. A restore needs all of them, so a month with one part still to send has none of the safety the count would be claiming.

**The vault is the pivot; every other origin is a source compared against it.** The raw archives today, the REST and websocket captures later — each has its own tree and feeds the same vault, so each asks the same question of the same counterpart. The section iterates the origins rather than naming them, so a new collector arrives with its own table already written, its own name in the column header.

---

## The page fills in rather than making you wait

One recursive Mega listing per origin — a few hundred objects with sizes and handles in a single call — plus one indexed member lookup per part. No downloads.

The trees are a different matter. Answering *how much is there* means measuring what is on disk, and that is **21.5 seconds** for the archives: 3.7 million files across seven venues, from 0.3s for okx to 7.3s for htx. The vault is free by comparison, and free in the literal sense — it is already being walked for the `built but nowhere` check, so its sizes are a by-product.

So the whole report is printed **before** the archives are counted, with `Counting…` where a size is still being measured, and redrawn in place as each venue lands. The height cannot change between paints — the venues are known before the first one, and the placeholder occupies a cell the way a size does — so nothing shifts and the only movement is text inside cells.

**Findings and the reclaim table are computed once and reprinted unchanged.** They depend on nothing being measured, and holding them back until the walk finished was the odd part.

Off a terminal there is no cursor to move, so everything is measured first and printed once: a piped table reading `Counting…` for ever would be worse than waiting for it.

**Sequential, and measured to be the right choice.** Walking the venues in parallel through async `fs` is **2.6× slower** — 55.8s against 21.5s — because the cost is not the device but Node: 3.7 million `stat` calls through the libuv threadpool, each with its own promise, against synchronous calls that skip all of it. Real parallelism would mean leaving Node for `du` or similar, which has not been tried.

An audit expensive enough to postpone is one nobody runs, which is why the wait is spent looking at the answer rather than at a cursor.

---

## What it does not do

**It does not repair.** Every finding has more than one correct response, and choosing between them is not a report's job. An orphaned object might be worth deleting or worth keeping until someone reads it; a size mismatch might mean the object is stale or the record is.

**It does not open a tar.** Everything is decided from sizes, handles and the record. Proving contents would mean downloading terabytes to answer a question the arithmetic already answers.

**It does not check the source tree.** Whether the files a part was built from are still on disk is [`cold evict`](COLD-EVICT.md)'s question, and it asks it there because that is where the answer is about to be acted on.

Related: [COLD.md](COLD.md), [COLD-PUSH.md](COLD-PUSH.md), [COLD-EVICT.md](COLD-EVICT.md).
