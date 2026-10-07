<!-- ─────────────────────────────────────────────────────────────────────────────
     Planning. Live scratch, not a description of anything that exists.
     Cut what is settled into the real docs; delete the file when nothing is left.
     ───────────────────────────────────────────────────────────────────────── -->

# Catalog — what is left

Prospector establishes what every venue publishes, the catalog serves it, and hauler brings it to
disk. How each works is [PROSPECTOR.md](../services/PROSPECTOR.md),
[CATALOG.md](../services/CATALOG.md) and [HAULER.md](../services/HAULER.md), and the API is
[CATALOG-API.md](../modules/CATALOG-API.md). Moving stocker onto the catalog is
[STOCKER.md](STOCKER.md). This is only the rest of the outstanding work.

## Instruments as an entity

An instrument is a row of its own — `(venue name, market, symbol)` — rather than a string every one of
its series repeats. Its properties are stated once, and series inherit them.

The entity, the link and the state are built — see
[PROSPECTOR.md](../services/PROSPECTOR.md#storage). What is left:

**Properties.** `margin` (`linear`/`inverse`/`quanto`), `base`, `quote`, `settle`,
`contract_size`, `expiry`, listed and delisted dates, and one `sources` column — a comma-separated
note of where the values came from (the venue's listing, a rule over the name, a seed, the files).
Adapters return them with the listing for live instruments; rules and seeds cover delisted ones.
Stocker then asks the catalog for margining, and its own symbol rules go.

**Then:** matching instruments across venues, which this opens the door to.

**The live database is fixed in place** so there is an honest backup to compare with, then set aside:
a catalog built from scratch must arrive at the same place by seeding and discovery.

## Slices and partitions

Built — see [PROSPECTOR.md](../services/PROSPECTOR.md#storage), [CATALOG.md](../services/CATALOG.md)
and [CATALOG-API.md](../modules/CATALOG-API.md#contents). What is left:

**The live database is a backup, not a catalog.** It was converted in place on 2026-10-04 so it can
be compared with a fresh one: its partitions carry counts taken from the old rollups, every version
is zero, and `file` has no `partition_id`. Prospector cannot run on it. The catalog built from
scratch is the first to hold real versions, and partition counts are what the two are compared by.

**An audit of the counters.** Nothing recounts a partition from its files today. The index on
`file.partition_id` is what makes it one range read; the check itself is unbuilt.

## Hauler

In order:

1. **Finish the first haul**, through `backfill-20` into `/data/tradebot/archives`. Every
   `downloaded_at` was reset on 2026-10-02, so the pass re-confirms everything already on disk and
   fetches the rest; a clean catalog should produce no `.bak` at all. The pass of 2026-10-07 produced
   370 for bitget — see *Prospector* below.
2. **Look at what it did not touch.** Every file the catalog lists gets the pass's date as its
   modification time, so a file under the archive with an older date is one nothing listed —
   misfiled, withdrawn, or junk.
3. **Compare the new catalog against `catalog.bak`** once every backfill has completed.
4. **The cold scripts, then stocker** ([STOCKER.md](STOCKER.md)), both on hauler's layout.

**A walk that fails partway waits 30 minutes, not 5.** `found` is only set by a finished walk, so a
failed listing request discards the progress the walk had made. Connection failures are retried now,
which makes this rare; whether a failed walk should come back sooner is undecided.

## Prospector

**okx's `'drop'` on 404 is still temporary** (`ruleOnFailure` in `okx.ts`). It sets a key down on its
first 404 instead of leaving it to be confirmed, which made okx's brute-force pass affordable. Remove
it once that pass is done — after draining any backlog rows still marked `confirmed`, since `'drop'`
is what bypasses their 30 attempts.

**The ticket ramp does not restart when venues are resumed mid-run.** It restarts on "Network back"
only. Proposed, not built.

**Bitget's seed describes the poorer of two copies of some days** — era-1 kline files that are
empty archives where an era-2 copy holds the day, and perp depth read from a folder holding a
fragment where the folder under the plain symbol holds the day. What was seen, what was not checked
and how to check it are in
[BUGS.md](BUGS.md#bitget-the-catalog-holds-the-poorer-of-two-copies-of-some-days). Seed work: every
pairing confirmed against the venue first, none inferred.

**Thin series that stopped.** Measured on 2026-10-02, 700 of bitget's 15,845 daily series hold fewer
than 50 files and published nothing after 2026-07-01 — 17,406 files, 0.3% of the venue's daily files.
Whether such series are worth keeping, and what threshold a monthly series would need, is undecided.

## Refreshing an unindexed venue

**Planned, not built.** An indexed venue heals by walking its index again. okx and bitget have none,
so both seeds were rebuilt from scratch — days of probing, the right cost once and the wrong cost
every year.

A completed seed makes the second time cheap, because it asked about every period of every series
and nothing below its horizon changes. So a refresh is an update with a lowered tip: pick a **trust
cut** a clear month below the day the seed ran, set every series' tip there, and the ordinary update
path covers the cut to today. It recovers files the tip ratcheted past and a `first` that is still
NULL; it deliberately does not revisit anything below the cut.

**The cut belongs to the seed**, recorded beside it rather than computed from the calendar.
