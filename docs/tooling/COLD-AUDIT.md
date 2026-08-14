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

A size can coincide; Mega's handle identifies the stored object independently of its path. It is recorded when an upload is confirmed, so a later run can tell "the same object is still there" from "something else now occupies that name". A part confirmed without one is reported, because that check can never be made for it.

---

## What the output looks like

Every section is the same shape — a title, a line saying what it is about, and a table. The first is the dashboard: **one row per venue, one column per tree**.

```
COLD STORAGE  every tree, by venue

┌─────────┬────────────────────────────────────┬─────────────────────────────────────┐
│ Venue   │ Vault                              │ Archives                            │
├─────────┼────────────────────────────────────┼─────────────────────────────────────┤
│ binance │ 108 mo (2017-07 → 2026-06)         │ —                                   │
│         │ 178 parts (81,962 files, 239.5GB)  │                                     │
│         │ 104 backed up (58.5 mo, 139.1GB)   │                                     │
├─────────┼────────────────────────────────────┼─────────────────────────────────────┤
│ bitget  │ 67 mo (2018-07 → 2026-06)          │ 41 mo (2018-07 → 2021-11)           │
│         │ 142 parts (20,964 files, 134.8GB)  │ 53 parts (64,321 files, 6.2GB)      │
│         │ 62 backed up (40.0 mo, 3.8GB)      │ all backed up (6.2GB)               │
├─────────┴────────────────────────────────────┴─────────────────────────────────────┤
│                                                                                    │
├─────────┬────────────────────────────────────┬─────────────────────────────────────┤
│ all     │ 252 mo                             │ 160 mo                              │
│         │ 465 parts (222,335 files, 505.9GB) │ 397 parts (2,582,705 files, 1.3TB)  │
│         │ 311 backed up (175.5 mo, 274.5GB)  │ 343 backed up (157.1 mo, 1.0TB)     │
└─────────┴────────────────────────────────────┴─────────────────────────────────────┘
```

**A venue's trees are two halves of one question — is this venue safe — so they belong side by side.** A column per data point spread one venue's answer across six columns and two tables a screen apart, and comparing its vault against its archives meant holding one set of numbers in your head while reading the other. REST and websocket arrive as two more columns rather than two more tables.

**Three lines per cell, in the order the questions come in.** How far does this go, how big is it, and how much of it would survive this disk dying.

**The first line spans everything known, not only what is in Mega.** That reverses an earlier choice — the range used to be of uploaded months, because `0 months` across `202109–202311` read as loss rather than backlog — and it is only safe because the third line now says what is backed up in its own right. The difference between lines two and three *is* the backlog, per venue and per tree, which is strictly more than the single footer it replaced.

**Size is last on both lines that carry one**, so the two land in roughly the same place and a glance down the cell compares them without reading either. Bytes first put the number this is really about — how much is safe — beside a file count on the line below it.

**Backed-up months carry one decimal; the first line never does.** A partially uploaded month is neither in nor out, and rounding it either way is a lie in a table whose whole job is saying where things stand. Each month contributes the share of its parts that have landed, so `16.3` reads as "sixteen months and a bit of another" — a signal that something is mid-flight, not a measurement to act on.

**Month counts add across venues; the months themselves do not.** Seven venues each holding `2020-03` are seven venue-months of data and one calendar month, and a totals row built by unioning them printed `108 mo` under a column adding to 252.

**A complete tree says so instead of repeating itself.** `27 backed up (27.0 mo, 2.0GB)` under `27 parts (2.0GB)` is the same three numbers twice, and most venues sit in exactly that state.

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

## What it costs

One recursive listing per origin — a few hundred objects with sizes and handles in a single call — plus one indexed member lookup per part. No downloads, and no walk of the source tree.

That is deliberate: an audit expensive enough to postpone is one nobody runs.

---

## What it does not do

**It does not repair.** Every finding has more than one correct response, and choosing between them is not a report's job. An orphaned object might be worth deleting or worth keeping until someone reads it; a size mismatch might mean the object is stale or the record is.

**It does not open a tar.** Everything is decided from sizes, handles and the record. Proving contents would mean downloading terabytes to answer a question the arithmetic already answers.

**It does not check the source tree.** Whether the files a part was built from are still on disk is [`cold evict`](COLD-EVICT.md)'s question, and it asks it there because that is where the answer is about to be acted on.

Related: [COLD.md](COLD.md), [COLD-PUSH.md](COLD-PUSH.md), [COLD-EVICT.md](COLD-EVICT.md).
