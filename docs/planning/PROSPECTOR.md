<!-- ─────────────────────────────────────────────────────────────────────────────
     Planning. Live scratch, not a description of anything that exists.
     Cut what is settled into the real docs; delete the file when nothing is left.
     ───────────────────────────────────────────────────────────────────────── -->

# Prospector — what is left

How prospector works is [PROSPECTOR.md](../services/PROSPECTOR.md). This is only the outstanding work
on it.

## Open work

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

**Binance's correction changelogs as a hint.** Binance lists the files it corrected in place, in
dated changelogs in its public-data repository
([BINANCE.md](../venues/BINANCE.md#binance-announces-its-own-corrections)): the key stays and the
bytes move. Reading them would point at exactly those keys. Worth doing once in-place changes
matter, treated as a hint rather than truth, and behind a generic "this venue announces changes"
seam rather than a branch for one venue. Not built.

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
