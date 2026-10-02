# Roadmap

Where the project is going, and in what order. **What is needed, not how it gets built** — the
"how" belongs in [planning/](planning/), and is written when a phase is approached rather than in
advance.

**Read this first if you are picking up work.** It is the map. Every phase links to whatever decides
its detail, where such a thing exists yet.

---

## Outstanding: the first haul

Hauler downloads through the `backfill-20` lens (every venue, up to 2020-12) into
`/data/tradebot/archives`. Files already there are verified and touched, not
fetched again. See [planning/CATALOG.md](planning/CATALOG.md#hauler).

---

## What this is building toward

Five parts, each depending on the one before it:

**1 · Collect** every dataset worth having from the venues that matter — seven today.

**2 · Normalise** all of it into Parquet the vault serves to DuckDB, so a question is a query and
never a parsing job.

**3 · Categorise the markets.** A market is a venue and an instrument, and they are not
interchangeable: volume, liquidity, volatility and whatever else proves to matter. The output is a
reasonably good predictor of **which markets are worth exploring for which kind of strategy** — a way
to stop guessing where to point the next experiment.

**4 · Finish the simulator** ([`../tradebot-sim`](../../tradebot-sim), its own repository).

**5 · Build the replay engine** — clones of each venue's own REST and WebSocket surfaces, so a bot
cannot tell replay from live.

Which is to say: **gather the data, find the targets worth trading, develop strategies against real
history, then validate or reject them under conditions realistic enough to trust.**

### The simulator and the replay engine are different beasts

Not two stages of one thing, and neither substitutes for the other.

**The simulator does maths on the data.** No bot, no APIs, no abstractions — it walks the history and
computes. That is what makes it fast, and it pays for the speed in everything it ignores: order-book
thickness, latency, race conditions.

**The replay engine reproduces the conditions.** It serves the same history over each venue's real
REST and WebSocket surfaces, so a bot trading against it runs exactly the code it would run against
the venue. It pays for that in speed.

**The verdict is one-directional, and that is the whole point.** A strategy that fails the simulator
has no chance in the real world, so the bad is discarded quickly and cheaply. The converse does not
hold at all: a strategy that looks excellent in the simulator can still fail badly against latency,
limited APIs, rate limits, thin books, lag, system disruptions — and against the plain fact that a
program has to decide in real time from data as it arrives, not from a history it can see all of.

**The simulator also answers questions replay cannot sensibly be asked.** *What is the most a perfect
oracle could make in this market?* is a few passes over the data. Getting it out of a full replay
engine driving a bot through venue APIs would be absurd — and that ceiling is exactly what says
whether a market is worth a strategy at all.

---

## Where we are

**Part 1, with much of part 2 alongside it.**

**Historical archives first**, because they are the easiest to get and carry most of the value: most
venues publish trades, most publish klines, and **trades alone are the whole of the price action** —
the core input the simulator needs.

**Normalising as we go**, rather than after collection is finished. The archives are the first
origin through stocker, and doing them properly is what sets the shape that REST and WebSocket
captures will normalise into later.

Archives are slow going, and the reason is not the downloading: **everything alongside them is being
built at the same time** — the catalog, the tooling, the normalisation, the backups. That is the
investment. If it is done right, adding REST and WebSocket carries far less sideline work, because
stocker and the tooling are already shaped to grow with a new origin rather than be extended for one.

### How much of this is decided

**Detail arrives as a phase is approached, not before.** Part 3 is five miles away and it is fine for
it to be blurry and small — writing it out now would be inventing constraints from a distance and
then inheriting them.

The near horizon: **another week or two on archives and the orthogonal concerns**, then the rest of
part 1. By that point part 2 is likely near-resolved in machinery, with what remains being the many
datasets REST and WebSocket will bring that nothing has covered yet.

---

## Part 1 · Collect

Three origins, in the order they are worth having:

### Archives — published files, settled and complete

**Discover** — [prospector](services/PROSPECTOR.md) surveys what each venue publishes into the
catalog. Built.

**Serve** — the [catalog](services/CATALOG.md) answers what exists and lists each venue's files, through
a lens. Built.

**Download** — [hauler](services/HAULER.md) fetches what the catalog lists as still owed, through a
lens. Built.

**This is the phase in progress.** [planning/CATALOG.md](planning/CATALOG.md) is the plan, and
[Current work](#current-work--the-catalog-migration) below is where it stands.

### REST — what an API will hand back after the fact

A new service. Fills what the archives never published and what a WebSocket was not connected for.
Not started. What each venue's archive lacks — and so what REST is for — is in its doc under
[venues/](venues/).

### WebSocket — what only exists if you were listening

`services/hoarder` is partially implemented and parked. The last resort by design:
every channel it subscribes to has to be justified by a gap the other two origins cannot fill, because
a stream missed is gone for ever and a stream duplicated costs storage no one wanted.

## Part 2 · Normalise

One service, [stocker](services/STOCKER.md), turning every origin into the same Parquet vault.

**Archives are done**, apart from the order-book datasets, which have no series mapping yet —
[planning/STOCKER.md](planning/STOCKER.md) covers those.

**REST and WebSocket are pending**, and will be a matter of new series rather than new machinery if
the archive work has been done right.

## Part 3 · Categorise the markets

Nothing built, nothing planned. It becomes possible the moment the vault is trustworthy, and it is
what turns *we have data on 107 datasets* into *these markets are worth a strategy*. Worth stating
now because it is the first consumer of the vault that is not a backup tool, and therefore the first
real test of whether the vault answers questions or merely stores files.

## Part 4 · The simulator

[`../tradebot-sim`](../../tradebot-sim) — separate repository, separate docs, long-lived. Its own
`docs/ai/README.md` is the entry point.

## Part 5 · The replay engine

Serve the history back over each venue's real REST and WebSocket surfaces, driven by a clock internal
to the data. Not started.

---

## Orthogonal: getting everything safely to cold storage

This runs alongside every part above rather than after any of them, because the cost of losing data
is not proportional to how finished the pipeline is. Mega is the destination;
[tooling/COLD.md](tooling/COLD.md) and its companions describe what exists.

**Millions of files are impractical, so they are packed.** One month per venue, as one or more
`.pNN.tar` parts — not real multipart, just numbered tars sized to be restorable.

**Appending is not an optimisation, it is the requirement.** Dozens of terabytes over a home link
means a month is never packed once and forgotten: a newly collected dataset, one a venue only just
published, one found in a folder nobody had looked in — each has to join a month already in cold
storage as a new part, without re-uploading what is already there.

**Parts self-correct.** A venue occasionally modifies a historical file. Rare, and it must not mean
the month is silently wrong from then on.

**All three origins get backed up raw**, as collected, before normalisation — archives today, REST
and WebSocket captures when they exist. Raw is the only thing that cannot be recomputed.

**The vault is backed up too**, and appending matters *more* there than for raw. The origins advance
at different speeds over different eras, so a vault month is never finished all at once. Waiting for
every origin to align on a month before packing it would mean packing almost nothing.

---

## Current work — the catalog migration

Every stage has until now kept its own answer to *what exists and how far have we got*. The catalog
replaces that with one queryable thing prospector writes and everyone else asks over HTTP, through
the catalog service.

**[planning/CATALOG.md](planning/CATALOG.md) is the plan.** Iteration 1 — the catalog, its schema and
its API — is built, and documented in [modules/ARCHIVES.md](modules/ARCHIVES.md),
[services/PROSPECTOR.md](services/PROSPECTOR.md) and [services/CATALOG.md](services/CATALOG.md).

**Catalog → archives → vault**, each layer made trustworthy before the one above depends on it.
Building upward out of order produced most of [BUGS.md](planning/BUGS.md): a tip read as a claim about
everything below it, a floor derived from one dataset, months built from raw still arriving. The vault
is deliberately last because it is the only **fully reproducible** layer — raw is entirely local, so a
rebuild costs CPU rather than bandwidth.

### 1 · Make the catalog rock solid

**Every venue is surveyed; okx and bitget still need their seeds rebuilt.** Neither can be listed, so
their series have to be known before anything can be asked and arrive as a seed rather than by
discovery — which makes the seeds the load-bearing part. That rebuild is the last outstanding
prospector work, and everything about it — the run in progress, the temporary changes to revert, and
what must happen before the output can ship — is in
**[planning/CATALOG.md](planning/CATALOG.md)**. How the service works is
[services/PROSPECTOR.md](services/PROSPECTOR.md).

**Deciding what to do about data we do not want.** Venues publish the same month several ways — okx
trades monthly *and* daily, binance most periods both ways — and the catalog records all of it, by
design. A month holding both renderings can never be closed, so every consumer waiting on it waits
for ever. Unsolved, and the last thing between the catalog and a downloader that can be pointed at a
venue and left alone
([CATALOG.md](planning/CATALOG.md#unsolved-what-to-do-about-data-we-do-not-want)).

**Gate's 85 exclusions** must reach the catalog before gate's first survey, or the bad files are
catalogued and offered for download. They live in trucker's code today and disappear with it.

**A survey is decided by its worst partition.** Binance and gate each end with one partition walking
alone for hours while every worker idles — 29,150 and ~9,500 pages respectively. The archive is
carved up once, up front, from directory *shape*, which is not size.
[planning/SCOPING.md](planning/SCOPING.md) replaces that with partitions refined on demand, using
idle workers as the signal.

### 2 · Make the archives rock solid — trucker on the catalog

Trucker stops discovering and starts asking: fetch venues, fetch a batch, download, report, loop.
Deletes seven modules and the class of bug that came with them
([CATALOG.md § Iteration 2](planning/CATALOG.md#iteration-2--trucker)).

**Audit every venue's floor** — bybit's was `202001` while the catalog proved it publishes from
`201910`, hiding 1,104 files across three datasets. One indexed `min(date)` per venue against the
adapter's floor; not yet run for the others.

**Gaps fill themselves.** Once trucker asks the catalog rather than its own ledgers, anything
previously missed is an ordinary pending file. No backfill step for the surveyable venues.

### 3 · Rebuild the vault — stocker on the catalog

Stocker takes its month queue from the catalog and processes much as it does now; the tip concept and
the `archives` facts dependency go. The vault, its Mega copy and its `vault` / `vault:details` /
`logs:vault` facts have been discarded rather than patched further, so what replaces them is built
once, on new rules, from a catalog and an archive tree already trusted.

This is where stocker's accumulated patches get undone rather than extended:

- **Complete months wherever they are**, not a contiguous frontier from a tip. A gap below the tip is
  a month to build when it closes, not a wall.
- **Never process an open month**, empty or not. Leftover files from an abandoned layout are not a
  reason to build.
- **One rebuild, after the above exists.** Raw is entirely local, so it costs CPU and one re-upload —
  and doing it under the rules being removed would reproduce the vault that was just thrown away.

### 4 · Tooling

Whatever has not already been done alongside the steps above. Tooling changes may interleave wherever
they are useful rather than waiting for the end.

One hard dependency: **`cold audit` reads `archives` facts** for its month counts, so it needs the API
or another source before that topic is retired.

---

## Smaller things, not yet scheduled

Understood well enough to do; none justifies a planning document.

**Delete the vault rows from `cold.sqlite`** — 411 parts, 152,401 members, `origin='vault'`. Deferred
only because `cold push archives` held the database. Nothing else there is vault-scoped.

**Refresh `cold audit` on a loop**, every 10 minutes, so a long run can be watched.

**Guard against a wrong `VAULT_DIR`.** The default cannot tell "not configured" from "configured to
the default", so a wrong root reads as an empty vault rather than an error — and for `evict`, absence
is an input to what it considers reclaimable.

**okx's day-major layout cannot be grouped.** `trades/daily/<YYYYMMDD>/` spreads one symbol-month
across 29 directories, and `scattered` cannot fix it because it requires a symbol-major walk. A
`scattered: 'symbol' | 'period'` distinction is the shape that fits — [BUGS.md](planning/BUGS.md).

**Three deferred optimisations in the facts store**, all measured, none a correctness gap: a digest of
the input set so stocker stops reading 2.4M member rows per sweep, a narrower query for
`cold evict archives`, and one home for the partition id currently built from columns in two places
([shared/pipeline/README.md](../shared/pipeline/README.md)).

**`subject` carrying every path extra** is latent until the order-book series land — the first with
more than one.

**Where a delisting date lives is a per-venue question nobody has asked yet.** Retirement works —
every venue answers `instruments()` and the preamble reconciles against it — but no venue *states*
when an instrument stopped, so an end is inferred from the archive going quiet, at about a month of
patience per dead series. Some venues publish a date or a state, and some may serve an endpoint that
includes the dead; taking those would replace the wait with a fact. A survey, not a change.

---

## Not in this line of work

**[planning/archived/PLAN.md](planning/archived/PLAN.md)** and **[planning/archived/MILESTONES.md](planning/archived/MILESTONES.md)** —
the bot app: signal, strategy and execution above the exchange layer. Dormant while the data pipeline
it would be built on is made trustworthy.
