# cold evict

`cold evict [origin] [venues…]` reclaims local disk once cold storage provably holds what is being deleted. See [COLD.md](COLD.md) for the namespace and origins, and [COLD-PUSH.md](COLD-PUSH.md) for how things got into cold storage in the first place.

**This is the only irreversible command in the family**, and the safeguards are the confirmation that lists what would go and defaults to no, and the trash that catches what does. Naming the origin is not one of them, so it prompts like the rest — an argument that errors out instead of asking only teaches people to type it without reading it.

---

## The order that makes it safe

```
collect  →  normalise  →  back both up  →  evict what is provably in both
```

Eviction comes last because it is the one step that cannot be undone. Get the order right and a mistake anywhere earlier is recoverable from Mega; get it wrong and no amount of checking downstream helps.

---

## Two trees, two rules

| | [archives](#archives-a-venue-month-at-a-time) | [vault](#vault-a-selection-at-a-time) |
|---|---|---|
| unit of decision | a venue-month, judged whole | a partition, judged alone |
| what is asked | is it in Mega, **and** did it reach a partition that is | is it in Mega |
| what selects it | venue | venue, market, dataset, symbol, period |
| a match that is not in Mega | blocks its whole month | is named and kept |

They share the deleting and nothing else. Both hold their own lock, so evicting one tree never blocks pushing either.

**Why the vault asks one question and the archives ask two:** raw exists in order to become Parquet, so raw that became none is a gap worth stopping on. A partition is the end of the line — there is no downstream to be aligned with, and nothing to substitute for the check.

---

# archives: a venue-month at a time

## Two questions, and they are not the same one

**Is it safe to delete?** The raw is in Mega, and what Mega holds is exactly what is on disk. Answered entirely from `cold.sqlite`, and it is what makes the deletion recoverable.

**Is it finished with?** Every file reached a partition, and that partition is itself in Mega. Answered from what stocker says it built, joined to the vault side of cold storage.

The second is **not** a safety property. A file backed up as raw can be deleted with nothing lost either way. It is about **alignment**: raw exists in order to become Parquet, so raw that became none is either something the collector should stop fetching or something stocker should be modelling. Evicting it would settle that question by forgetting it. Blocking says so out loud instead — which is how gate's unmodelled spot klines were found, and they are recorded in [BUGS.md](../planning/BUGS.md) rather than quietly reclaimed.

---

## What is checked, per venue-month

| condition | verdict |
|---|---|
| a part of the month is not in Mega yet | **blocked** — part of the month exists nowhere else |
| a file on disk Mega has never seen | **blocked** — deleting it would destroy the only copy |
| a file whose size or mtime moved since packing | **blocked** — Mega's copy is of something else |
| a file that reached no partition | **blocked** — alignment; fix the collector or stocker |
| a file whose partition is not in Mega yet | **blocked** — the chain is not complete |
| some files gone from disk, the rest still there | **prompt** — nothing to lose, but say so |
| nothing left on disk at all | **already reclaimed** — counted, never offered |
| everything agrees | **clear** |

**Extra or changed blocks; missing only warns.** A file present locally and absent from Mega is destroyed by proceeding, and a file whose size or mtime has moved means the tar in Mega captured something else — both are reasons to stop. A file Mega holds and disk does not costs nothing to proceed on, because there is nothing there to lose. It is still reported: something removed raw outside this command, and agreeing to that is asked as a **separate** prompt defaulting to no, rather than riding along with the first.

**Unless nothing is left, which is this command's own finished work.** A month evicted last week has every file recorded in cold storage and none of them on disk. That is not a discrepancy — it is the state the whole family aims at. Treating it as a caveat offers a deletion that can only free zero bytes, and because the record is never removed, every month ever evicted stays on that offer for good. One run had sixty-two of them burying the two months that actually had something to reclaim. They are counted on one dim line and never prompted for.

So the second prompt only appears when part of a month survives and the rest has vanished — genuinely odd, and genuinely worth space.

Size and mtime are the whole comparison — no hashes. mtime is when the collector wrote the file locally, so a re-fetch moves it. A rewrite that preserved both would slip through, which is a smaller risk than reading every byte of a multi-terabyte tree on every run.

---

## Two things that must not vouch for themselves

**A partition Mega holds an older copy of does not count as backed up.** Stocker rewrites a partition in place when its inputs change, so what is in cold storage can be a thinner version of what is on disk — and the raw about to be deleted is what the *current* one was built from. The check is the same comparison `cold push vault` makes to decide what to repack: local size and mtime against the `member` row. A drifted partition blocks its month until that push has run, so eviction stops depending on the order somebody happened to run things in. A partition that is simply *gone* locally is not drift — that is the steady state this whole family aims at.

**Only the current build of a partition vouches for its inputs.** A raw file dropped by a rebuild must stop counting, or it goes on vouching for itself out of a record that no longer describes anything. That is not hypothetical: bitget's klines were rebuilt from one of their two published layouts at a time, so every raw file appeared in *some* record while the partition on disk held half of them — thirty-five months read as fully normalised and were offered for eviction, taking with them the raw the repair needed.

**This command cannot enforce it, so the producer must.** A superseded member and a current one are indistinguishable once both are in `vault:details`; the reader has nothing to tell them apart by. Stocker replacing a partition's members on rebuild is what keeps the rule true, and the check against the flat files at migration confirmed the two agree today — identical for all six venues, no key and no id differing.

---

## It stays answerable

Examining a venue is a quarter of a million `stat` calls, and none of it yields on its own. Node delivers a signal through the event loop, so a handler cannot run while a synchronous stretch holds the stack — the signal is not lost, it is queued behind work that has to finish first, which reads exactly like a command ignoring Ctrl-C.

So the walk hands the loop back every few thousand items. A tick costs microseconds against thousands of `stat`s, far below measurable, and Ctrl-C lands in milliseconds rather than a minute.

The venue list is asked of the parts, never of their members: the same answer can be had by reading every member row and collecting the distinct venues, which was 2.46 million rows and 67 seconds to produce six strings — before the command had printed anything or could answer a signal.

---

## What it prints

The answer is **what can be reclaimed**, grouped by venue and naming every month:

```
bitget — 36 months · 31,747 files · 1.5GB
    201807            28 files      611.6KB
    201808           223 files        7.0MB
    201809           278 files        7.2MB
    …
36 months clear · 31,747 files · 1.5GB
```

**Every month is named, however many there are.** This is the one irreversible command in the family, and a summary that fits on a screen is worth less here than a list somebody can actually check before answering: a range hides which months are inside it, and one that looks unremarkable is exactly how a month nobody meant to reclaim goes with the rest. The trash catching a mistake afterwards is a reason to be able to undo one, not a reason to make one easy.

Grouped by venue because that is how the question is held, and each month carries its own file count and size — the two numbers that say whether it is the month you were thinking of.

**A blocked month is counted, never explained.** Raw that is not open for eviction yet is the ordinary state of raw — still being collected, not yet normalised, its partition not yet backed up — and none of that is a fault worth a line. Listing each one turns an answer about what can be reclaimed into a page of warnings about what cannot, which is the wrong half to print.

Where a genuine discrepancy hides among them, [`cold audit`](COLD-AUDIT.md) is what surfaces it, and the size of the tree on disk is the other tell. The months evictable *with a caveat* keep their reasons, because those are a decision the operator is about to make rather than a state to be informed of.

---

## Decide per month, delete per file

The month is the unit of the **decision**, because that is the unit cold storage packs and the unit a collector closes.

It is not the unit of **deletion**. Only paths recorded as members of an uploaded part are removed, one at a time. Anything that arrived after the month was packed is in no part, was not part of the judgement, and must survive — removing the directory would take it too.

Directories are then removed with `rmdir`, which **fails on a directory that is not empty**. That is the point: if something wrote there between the walk and the delete, the removal declines and the next run reports the difference, rather than a forced delete destroying whatever landed.

---

---

## What the alignment check depends on

`cold.sqlite` answers everything except one question: **which raw file became which partition**. Cold storage knows raw paths and it knows Parquet paths, and nothing in it connects the two, because that connection is a record of what stocker did rather than of what was backed up.

So the alignment check reads what stocker has published — `topic=vault:details` in the facts store, where each member's raw path is the fact and the partition it fed is the key it is filed under. That is the same kind of dependency `cold push archives` already has on the collector's published tips: a documented output, not a reach into internals. It is confined to `ledger.ts`, which [`cold push vault`](COLD-PUSH.md#what-makes-a-vault-month-a-candidate) also uses for a different question, so the reading lives in one place rather than two.

A partition's id is rebuilt from cold storage's own `member` columns rather than by reconstructing a vault path, which would mean copying stocker's layout rules into this command:

```
member  venue=… market=… symbol=… dataset=… variant='interval=1w' month='201707'
        →  klines|binance|spot|BCCBTC|1w|2017-07
```

`variant` holds the extras as the `key=value` text the path used, in the order the id writes them, so taking the values in order reproduces the string exactly.

This is the whole of what `evict vault` does **not** need. It reads the record and the tree, and nothing else.

---

# vault: a selection at a time

**One question, per partition: is this exact file — path, size and mtime — inside a tar Mega holds?** Nothing else. There is no month-wide verdict, no alignment check, and no second prompt.

That holds under both ways stocker changes the tree:

- **A partition is rebuilt.** It is written in place, so its mtime moves and it reads as not-in-Mega until `cold push vault` repacks it.
- **A new dataset appears** — one discovered in a venue, one newly modelled, order books when they land. All-new paths, so it appends as the next part and touches nothing already backed up.

In both cases the partitions already evicted are irrelevant: what comes back is new bytes either way, and cold storage takes them as an update or as an addition. The absence of what was reclaimed changes neither.

## Selective, because that is what it is for

The vault is what gets pulled back down to work with, so the normal shape is not a sweep — it is *keep every BTC and ETH future, reclaim the rest*, or *work on binance for a month, reclaim everything else*.

```
tools cold evict vault binance --symbol=ETHUSD --dataset=trades --period=2017,2018,2019,2020
```

Venues are positional and take several. The rest are options, each a comma-separated list, each independently optional:

| option | matches |
|---|---|
| `-M, --market` | `market=` — spot, futures, and whatever a venue calls its own |
| `-D, --dataset` | `dataset=` — trades, klines, funding |
| `-S, --symbol` | `symbol=`, **whole and exact** |
| `-P, --period` | the month, as `YYYY` or `YYYYMM` |

**An unnamed dimension means all of it**, which is the only way to say "everything" — there is no wildcard to mistype into a wider deletion than was meant. Matching is case-insensitive, since the filter is typed and the tree is not.

**A period is a prefix of the month**, so `2018` and `201803` are one rule rather than two. **A symbol is not.** `BTC` catching `BTCUSDT` would be convenient for *keep* and disastrous for *reclaim the rest*, and this is the command where that asymmetry decides. A token that is not four or six digits is rejected rather than matched loosely: a period nobody can match is indistinguishable from a selection that is genuinely empty, and "nothing matched" is exactly what a typo looks like.

The four options apply to the vault **only**. Archives have no dataset, symbol or market to speak of — seven venues, seven tree shapes, and no level that reliably names one — so a filter over them could match nothing, and accepting it silently is how somebody comes to believe they narrowed a deletion that was in fact total. It is an error there, not an omission.

## A selection cuts across tars, and that is fine

A tar says a partition **can be restored**, not that it is the only thing riding on that object. Reclaiming four symbols out of a tar that holds two hundred leaves the tar exactly as it was and every one of those two hundred still restorable. Nothing in cold storage is rewritten by an eviction — the record is not touched at all.

## What cannot go is named, and there is no override

Matching partitions cold storage does not hold are excluded, listed with their reason, and never offered:

```
⚠ 42 matching partitions are not in Mega and will be kept
         38  never packed — not in cold storage at all
             dataset=trades/venue=okx/market=swap/symbol=SOL-USDT-SWAP/…202401.parquet
             … and 35 more
          4  changed since it was packed — Mega holds an older build
    Run 'tools cold push vault' to back these up, then evict again.
```

Everything else in this family reports what cannot be done quietly, because raw not being ready is the ordinary state of raw. Here it is the opposite: these were *asked for* and are not being given, so they are warned rather than dimmed.

A filter is a request for what to reclaim. It is never permission to lose the only copy of something, so there is no flag that turns this into a deletion.

## What it prints

The selection is stated back before anything is counted — a filter that reads back wrong is the cheapest mistake to catch, and the only place to catch it is before the numbers, which look plausible whatever was asked for:

```
Selection: venue=binance · dataset=trades,klines · period=2017,2018,2019,2020
190,412 partitions in the vault · 12,904 matching

binance — 2 datasets · 12,904 partitions · 412.7GB
    trades        201701 → 202012        8,201 partitions      301.2GB
    klines        201701 → 202012        4,703 partitions      111.5GB

12,904 partitions clear · 412.7GB
```

Grouped by **venue and dataset**, because that pair is what somebody asks to reclaim. Not by month: the vault is judged a partition at a time, and a month grouping would imply a month-wide decision that is not being taken. Each dataset carries its month span, which is the part worth checking before saying yes.

---

# Both trees

## Files go to the trash

Every check above has to be right for a deletion to be safe, and the one thing none of them covers is a bug in the checks themselves. Moving to the host's trash costs nothing and turns that class of mistake from permanent into a restore.

It matters more for what is coming than for archives today: an archive file can be fetched from the venue again, a websocket capture never can.

**It lands on the same filesystem**, which is what makes it viable at this size — `<volume>/.Trash-$uid/` for a file on that volume, so it is a rename rather than a copy of the whole tree into `$HOME`. `gio` selects that per-volume trash itself and writes the `.trashinfo` record holding the original path and the deletion date. That record is what makes a restore possible, and is why the trash is only ever handled through `gio` and never by moving files into `.Trash-*` by hand.

**It frees no space until the trash is emptied**, and the command says so rather than letting the number look wrong. A command for reclaiming disk that reclaims none reads as broken until the second step is seen for what it is: a chance to look at what was taken before it goes. Emptying belongs to a file manager, not here — the trash holds other things too.

**A failed trash is never retried as a delete.** If `gio` is unavailable or the volume refuses, the month fails and is reported. Falling back to the irreversible form of an operation whose whole purpose was to be reversible is not a fallback.

`--purge` deletes outright, for when that is genuinely wanted.

---

## What was reclaimed is recorded

`evict` writes to `cold.sqlite` once, after the deletion: a row per thing that is now only in Mega.

**Without it, "packed" and "packed then evicted" are indistinguishable**, and telling them apart costs a `stat` per file — 2.6 million for the archives. That makes the only question worth asking about a venue uncomputable: *how much is there, and how much of it is safe*. What is on disk plus what is in cold storage double-counts everything still in both, and either half alone is wrong — counting only local makes a venue **shrink** as it is backed up and cleaned, which is precisely backwards.

**An eviction belongs to a part, which is what makes it free.** A part already records the size and count of its members, exactly and permanently — verified across all 580 of them, `part.bytes` is `SUM(member.bytes)` and `part.files` the member count, with no drift. A part cannot change under it either: rebuilding one produces a *different* part. So a month of hundreds of thousands of files reduces to a handful of rows carrying their own totals, and the audit's question is one `SUM` rather than a join into millions of rows.

Nothing can be evicted that was never backed up, so every eviction has a part to belong to. There is no other case.

```sql
CREATE TABLE evicted (
  part_id INTEGER NOT NULL REFERENCES part(id) ON DELETE CASCADE,
  path    TEXT    NOT NULL DEFAULT '',   -- '' = the whole part
  bytes   INTEGER NOT NULL,
  files   INTEGER NOT NULL,
  at      TEXT    NOT NULL,
  PRIMARY KEY (part_id, path)
);
```

**Two grains, because the two trees evict differently.** Archives go a whole month at a time, so every part of the month goes whole and `path` stays empty. A vault eviction is a filter — a symbol, a dataset, a year — so a month is rarely taken whole, and a row names one partition instead; recording the part would claim partitions that are still here. The vault uses the empty path too when a whole month goes, which is the default.

**The sizes are stored rather than joined.** They are recoverable from `member` in both trees, so this is a denormalisation and not a necessity — bought because it makes the total one `SUM` over a handful of rows, and because what a reclaim freed is a fact about that moment. If it ever disagrees with the part it came from, that is a bug and not a discrepancy to reconcile.

**Written after the deletion, and only for what actually went.** `reclaim` reports which groups it managed to delete, and only those are recorded — a group that failed still has its files, and a row saying otherwise would have every total under-count what exists.

**A restore deletes the row**; its absence is what says the data is back. A part that is replaced takes its evictions with it through the cascade, which is correct on its own terms: a replacement can only be packed from files that were restored first.

There is no `restored` flag and no history of evict-restore cycles. That is a deliberate omission rather than an oversight — there is not yet a way to restore, and a table recording the history of an operation that does not exist would be designed against guesses. When `cold pull` lands, whether the row is deleted or marked is a decision to take then.

---

## Interruption and exclusion

**Each tree holds its own lock, and eviction can run beside a push.** The two do not compete for files: evict deletes only what an *uploaded* part records, and push plans only what no part records at the same size and mtime — so the two sets are disjoint by construction rather than by scheduling. Push already treats the tree as something that moves underneath it, skipping a directory it cannot read and a file it cannot stat, and evict never writes to `cold.sqlite` at all.

Sharing a lock bought none of that and cost real availability: a push that runs for days would lock eviction out for days, which is precisely when a filling tree most needs reclaiming.

Nothing is deleted before the confirmation is answered, so Ctrl-C at any point before that leaves the tree untouched. After that, each file is moved independently: an interruption leaves some in the trash and the rest in place, and re-running re-derives the same answer from what is there now.

---

## Environment

The same variables [`cold push`](COLD-PUSH.md#environment) uses. `evict archives` additionally reads `VAULT_DIR`, even though it is deleting from `ARCHIVES_DIR` — a partition's local size and mtime are what say whether cold storage holds the current build of it.
