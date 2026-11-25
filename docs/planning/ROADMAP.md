<!-- ─────────────────────────────────────────────────────────────────────────────
     Planning. Where the project is going, not a description of anything that exists.
     Cut what lands; the services' own docs say how things work.
     ───────────────────────────────────────────────────────────────────────── -->

# Roadmap

Where the project is going, and in what order. **What is needed, not how it gets built** — the
"how" belongs in the other plans beside this one, and is written when a phase is approached rather
than in advance.

**Read this first if you are picking up work.** It is the map. Every phase links to whatever decides
its detail, where such a thing exists.

---

## What this is building toward

Five parts, each depending on the one before it:

**1 · Collect** every dataset worth having from the venues that matter — seven today.

**2 · Normalise** all of it into Parquet the vault serves to DuckDB, so a question is a query and
never a parsing job.

**3 · Categorise the instruments.** An instrument at one venue is not interchangeable with the same
instrument at another, nor with its neighbours at the same venue: volume, liquidity, volatility and
whatever else proves to matter. The output is a reasonably good predictor of **which instruments at
which venues are worth exploring for which kind of strategy** — a way to stop guessing where to point
the next experiment.

**4 · Finish the simulator** (the tradebot-sim repository, separate from this one).

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
oracle could make on this instrument at this venue?* is a few passes over the data. Getting it out of
a full replay engine driving a bot through venue APIs would be absurd — and that ceiling is exactly
what says whether an instrument at a venue is worth a strategy at all.

---

## Where we are

**Part 1, with much of part 2 alongside it.**

**Historical archives first**, because they are the easiest to get and carry most of the value: most
venues publish trades, most publish klines, and **trades alone are the whole of the price action** —
the core input the simulator needs.

**Normalising as we go**, rather than after collection is finished. The archives are the first
source through stocker, and doing them properly is what sets the shape that REST and WebSocket
captures will normalise into.

**Catalog → archives → vault**, each layer made trustworthy before the one above depends on it. The
vault is deliberately last because it is the only **fully reproducible** layer — raw is entirely
local, so a rebuild costs CPU rather than bandwidth.

Archives are slow going, and the reason is not the downloading: **everything alongside them is being
built at the same time** — the catalog, the tooling, the normalisation, the backups. That is the
investment. If it is done right, adding REST and WebSocket carries far less sideline work, because
stocker and the tooling are already shaped to grow with a new source rather than be extended for one.

### How much of this is decided

**Detail arrives as a phase is approached, not before.** Part 3 is five miles away and it is fine for
it to be blurry and small — writing it out now would be inventing constraints from a distance and
then inheriting them.

---

## Part 1 · Collect

Three sources, in the order they are worth having:

### Archives — published files, settled and complete

**Discover** — [prospector](../services/PROSPECTOR.md) surveys what each venue publishes into the
catalog. Built.

**Serve** — the [catalog](../services/CATALOG.md) answers what exists and lists each venue's files,
through a lens. Built.

**Download** — [hauler](../services/HAULER.md) fetches what the catalog lists as still owed, through
a lens. Built.

**This is the phase in progress**, and its open work is beside this plan: the catalog's in
[CATALOG.md](CATALOG.md), prospector's in [PROSPECTOR.md](PROSPECTOR.md), hauler's in
[HAULER.md](HAULER.md). Beyond those:

**okx's `'drop'` on 404** (its adapter's `ruleOnFailure`): whether and when it goes is in
[PROSPECTOR.md](PROSPECTOR.md#open-work).

**Deciding what to do about data we do not want.** Venues publish the same month several ways — okx
trades monthly *and* daily, binance most periods both ways — and the catalog records all of it, by
design. A month holding both renderings can never be closed, so every consumer waiting on it waits
for ever. Unsolved, and the last thing between the catalog and a downloader that can be pointed at a
venue and left alone.

**Audit the seeded venues' floors.** okx and bitget cannot be listed, so each of their series is
probed upward from the `floor` its seed states. A floor set too late hides every file before it, and
no pass can notice, because nothing below a floor is asked. Not yet run.

### REST — what an API will hand back after the fact

A new service. Fills what the archives never published and what a WebSocket was not connected for.
Not started: nothing collects over REST. What the venues' APIs offer of history, set against what
each archive already holds, is surveyed in [REST.md](REST.md); what each venue's archive lacks is in
its doc under [venues/](../venues/).

### WebSocket — what only exists if you were listening

The last resort by design: every channel collected has to be justified by a gap the other two
sources cannot fill, established by comparing actual payloads rather than documentation, because a
stream missed is gone for ever and a stream duplicated costs storage no one wanted.

**Parked.** [hoarder](../../services/hoarder/README.md) relays four venues' streams verbatim to
RabbitMQ, and no module deploys it. Its channel lists — two symbols per venue, a trade channel and a
book channel each — stand until those payload comparisons decide what a socket must carry, and the
archive and REST sources have years of backfill to work through first.

**Binance futures is to be added to hoarder**, which collects Binance spot only. The futures endpoint,
and the paths that accept a subscription and send nothing, are in
[BINANCE.md](../venues/BINANCE.md).

**A dev tool to try any venue's WebSocket by hand comes with it.** A `tools` command that connects
to a venue, subscribes to a channel and shows what comes back: what the venue acknowledges, what a
message looks like, what it sends unasked. Low priority — it is built when WebSocket collection is,
not before.

## Part 2 · Normalise

One service, [stocker](../services/STOCKER.md), turning every source into the same Parquet vault.

**Archives are mapped, order books included; what is left is in [STOCKER.md](STOCKER.md).**

### Sources arrive one at a time

Stocker reads the archives today, where a file is a published archive of a finished period. The
other two sources land alongside it as their collectors mature: **WebSocket** files, which are
message streams with actions and partials rather than rows, and **REST** files, which are paginated
records. Each is more formats to read; the tables they project into are the same, so they are a
matter of new series rather than new machinery if the archive work has been done right.

Those readers are also what brings BitMEX's collected history into the vault. It is raw, in the vault
service's layout, and much of it arrived over REST and the WebSocket; it normalises through those
readers, not the archive one.

### Reduced order books — later

**The books the venues publish are too large to work with.** Cold storage for all of them would still
leave the working copy: a disk attached just to have the relevant books at hand is not a way to work.

**So the vault gets books of its own making, far smaller**: the top 25 to 50 levels of each book, as
snapshots or as throttled increments. Which of the two, and how deep, is open.

**From a venue's snapshots it is cutting the tail** — the levels beyond the depth kept are dropped.

**From a venue's increments it is a book kept whole and published pruned.** Every change is applied
to the full book in memory, and only what changes within the top levels is written; the rest moves
the book and is not written.

## Part 3 · Categorise the instruments

Nothing built, nothing planned. It becomes possible the moment the vault is trustworthy, and it is
what turns *we have the data* into *these instruments at these venues are worth a strategy*. Worth
stating now because it is the first consumer of the vault that is not a backup tool, and therefore
the first real test of whether the vault answers questions or merely stores files.

## Part 4 · The simulator

The tradebot-sim repository — separate repository, separate docs, long-lived. Its entry point is its
own `docs/ai/README.md`.

## Part 5 · The replay engine

Not started. It serves the normalised history over a **replica of each venue's own WebSocket and
REST API**, driven by a clock internal to the data, so a bot written against Bitget trades against
Bitget's interface whether it is pointed at the exchange or at ten years of history.

**A replay surface is built per venue, and only for venues worth trading on** — a bot trained against
an API it can never send an order to is wasted work. The simulator reads the vault directly rather
than through a venue API, so history from a closed venue keeps its value there without a surface
being built for it.

What it needs, whatever the venue: a timeline merging tables in time order, subscription handling,
backpressure to the slowest client, and a control API for seeking and speed.

---

## Orthogonal: getting everything safely to cold storage

This runs alongside every part above rather than after any of them, because the cost of losing data
is not proportional to how finished the pipeline is.

**Every source is backed up raw**, as collected, before normalisation — the archives today, REST and
WebSocket captures once they exist. Raw is the only thing that cannot be recomputed. **The vault is
backed up too.** And neither is ever finished: a month already in cold storage keeps gaining data, so
storing more of it has to add to what is there without sending it again.

How cold storage works is [tooling/COLD.md](../tooling/COLD.md); what is left of it is
[COLD.md](COLD.md).

---

## Smaller things, not yet scheduled

Understood well enough to do; none justifies a planning document.

**Where a delisting date lives is a per-venue question nobody has asked yet.** Every venue lists its
instruments, and the preamble marks what the listing no longer names as delisted — but the catalog
records no date an instrument stopped, so an end is inferred from the archive going quiet. Some
venues publish a date or a state, and some may serve an endpoint that includes the dead; taking
those would replace the wait with a fact. A survey, not a change.

---

## Not in this line of work

**The bot app** — signal, strategy and execution above the exchange layer — is out of scope until
replay exists; no current plan.
