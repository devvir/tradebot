<!-- ─────────────────────────────────────────────────────────────────────────────
     Planning. Live scratch, not a description of anything that exists.
     Cut what is settled into the real docs; delete the file when nothing is left.
     ───────────────────────────────────────────────────────────────────────── -->

# Catalog — what is left

Prospector establishes what every venue publishes, the catalog serves it, and hauler brings it to
disk. How each works is [PROSPECTOR.md](../services/PROSPECTOR.md),
[CATALOG.md](../services/CATALOG.md) and [HAULER.md](../services/HAULER.md), and the API is
[CATALOG-API.md](../modules/CATALOG-API.md). This is only the outstanding work.

## Instruments as an entity

An instrument is a row of its own — `(venue, market, symbol)` — rather than a string every one of
its series repeats. Its properties are stated once, and series inherit them.

The entity, the link and the state are built — see
[PROSPECTOR.md](../services/PROSPECTOR.md#storage). What is left:

**Properties.** `margin` (`linear`/`inverse`/`quanto`), `base`, `quote`, `settle`,
`contract_size`, `expiry`, listed and delisted dates, and one `sources` column — a comma-separated
note of where the values came from (the venue's listing, a rule over the name, a seed, the files).
Adapters return them with the listing for live instruments; rules and seeds cover delisted ones.
Stocker then asks the catalog for margining, and its own symbol rules go.

**Then:** matching instruments across venues, which this opens the door to.

## Slices and partitions

Built — see [PROSPECTOR.md](../services/PROSPECTOR.md#storage), [CATALOG.md](../services/CATALOG.md)
and [CATALOG-API.md](../modules/CATALOG-API.md#contents). What is left:

**The live database is a backup, not a catalog.** It is kept as it stands so there is an honest
copy to compare with: its partition counts were copied in rather than computed from its files,
every version is zero, and `file` has no `partition_id`, so prospector cannot run on it. A catalog
built from scratch must arrive at the same place by seeding and discovery; it is the first to hold
real versions, and partition counts are what the two are compared by.

**An audit of the counters.** Nothing recounts a partition from its files. The index on
`file.partition_id` is what makes it one range read; the check itself is unbuilt.

## Hauler

In order:

1. **Finish the first haul** through `backfill-20` into the archives directory. A clean catalog
   produces no `.bak`; bitget's seed is one known cause of them (see *Prospector* below).
2. **Look at what it did not touch.** Every file the catalog lists gets the pass's date as its
   modification time, so a file under the archive with an older date is one nothing listed —
   misfiled, withdrawn, or junk.
3. **Compare the new catalog against `catalog.bak`** once every backfill has completed.

**A walk whose first listing request is refused waits 30 minutes, not 5.** Connection failures and
`5xx` from the catalog are waited out and asked again, and a listing that fails after its first page
keeps what the walk fetched. What is left is a `4xx` before the first page: the walk fails and rests
the quiet interval. Whether it should come back sooner is undecided.

## Prospector

**Remove okx's `'drop'` on 404** (`ruleOnFailure` in `okx.ts`). It sets a key down on its first
404 instead of leaving it to be confirmed, which is what makes probing okx affordable. Taking it out
means draining any backlog rows still marked `confirmed` first, since `'drop'` is what bypasses their
30 attempts. Whether and when it goes is open.

**Re-measure okx.** Whether its 400-level book window rolls, and whether files are ever added for
past dates that once answered `404`, are open in [OKX.md](../venues/OKX.md). Repeating the
measurement months after the first settles both; if the book window rolls, its earliest months are
perishable and come first.

**gate's `probingLag`.** gate declares none and takes the default of 1. Its walks are scheduled once
a month, so most of its updates probe, and its measured publishing lag (PROSPECTOR.md's
`probingLag` table) asks for 2 or more by the rule the other adapters follow. At 1 its updates ask
for days that are not yet published; nothing is lost, only probes. Whether to declare 2 or 3 is
undecided.

**Encode when a file is expected.** Nothing models when a venue publishes. Doing so would pay twice
— nothing asked for before it is due, and silence that becomes suspicious on a schedule — but it
needs a per-venue leniency (binance publishes a month's files on the first Monday of the next).

**Replace `OVERDUE_DAYS` with a measurement.** A `file` row records when the catalog first saw a
file (`seen_at`) and its key the period it covers; the difference is that venue's publishing lag.
With a few months of it the one constant becomes a per-venue, per-dataset distribution.

**Binance's correction packages as a hint.** Binance publishes dated packages under `/updates` naming
files it changed in place ([BINANCE.md](../venues/BINANCE.md)): the key stays and the bytes move.
Reading them would point at exactly those keys. Worth doing once in-place changes matter, treated as
a hint rather than truth, and behind a generic "this venue announces changes" seam rather than a
branch for one venue. Not built.

**When the migration chain freezes.** While no catalog is shared or deployed, a change edits the
migration it belongs to and the one live catalog is brought to match by hand. Once the project has a
second developer or a production deployment, a migration that has shipped is frozen and the chain
only grows.

**The ticket ramp does not restart when venues are resumed mid-run.** It restarts on "Network back"
only. Not built.

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

**Not built.** An indexed venue heals by walking its index again. okx and bitget have none, so a
seed is built from scratch — days of asking the venue, the right cost once and the wrong cost every
year.

A completed seed makes the second time cheap, because it asked about every period of every series
and nothing below its horizon changes. So a refresh is an update with a lowered tip: pick a **trust
cut** a clear month below the day the seed ran, set every series' tip there, and the ordinary update
path covers the cut to today. It recovers files the tip ratcheted past and a `first` that is still
NULL; it deliberately does not revisit anything below the cut.

**The cut belongs to the seed**, recorded beside it rather than computed from the calendar.
