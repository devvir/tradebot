# Catalog lenses

A **lens** is a named way of looking at the catalog. Where one is in force, what it lets through *is*
the catalog as far as that consumer is concerned; the rows underneath stay complete and unfiltered.
Everything else in the catalog is a measurement; a lens is a decision, made entirely from what the
catalog holds.

It is how a consumer says what it wants without the catalog changing: hauler downloads through one,
stocker builds through one, cold storage decides through one, and a person browses through one. The
endpoints are in [CATALOG-API.md](CATALOG-API.md#lenses); the editor is in
[CATALOG-UI.md](../services/CATALOG-UI.md).

**Lenses belong to the catalog service, not to prospector.** Prospector collects everything a venue
publishes whatever anyone wants of it; a lens is a consumer's choice of what to read, which collection
neither knows nor acts on. So the catalog writes the `lens` table (the one table it writes) and
prospector never reads it.

## The definition

```jsonc
{
  "format": 1,
  "venues": {
    "*":      [{ "effect": "include", "to": "202012" }],
    "bitget": [
      { "effect": "exclude", "datasets": [{ "dataset": "books" }] },
      { "effect": "exclude", "datasets": [{ "dataset": "trades" }], "from": "201901" }
    ]
  }
}
```

**One row per lens, one JSON document, read whole and written whole.** Nothing queries across rules,
so normalising them would buy filtering and indexing nobody wants, and stable ids for rules whose only
identity is their position. There is no `PATCH` of a single rule; last write wins.

**Three names, doing different jobs.** `slug` is what a consumer is configured with and what every
path addresses, so it is stable; `name` is what a person calls it, free to change; `note` is what it is
for. Addressing by `name` would mean renaming a lens reconfigures whoever reads through it.

**Keyed by venue name**, never by id: an id names a *host*, and bybit publishes its books from a
second one.

**`*` holds rules about every venue, and they apply before a venue's own.** A lens whose only rule is
global reaches venues it never names — including ones added later.

**Rules apply in order, starting from nothing.** `include` adds what it matches, `exclude` takes it
away, and each rule sees what the ones before it left — which is what lets *everything up to a date,
except books, except recent trades* be three rules read top to bottom.

**A rule states only what it constrains.** An absent dimension means all of it:

| field | matched against |
|---|---|
| `markets`, `grains` | the pattern's own |
| `datasets` | a list of `{ dataset, variant? }`; an absent `variant` is every variant of that dataset |
| `instruments` | the series' symbol; `@` is the venue-wide file, and an ordinary value here |
| `from`, `to` | months, `yyyymm`, inclusive; absent is open |

Writing `markets: 'all'` everywhere was rejected: it is not more explicit, only longer, and it ages
the wrong way — datasets, variants and grains are *added* over time, and a rule that names only what
it constrains absorbs an addition where one enumerating every value silently stops covering it.

**A variant belongs to its dataset**, which is why the two travel as a pair: two flat lists could not
say *one length of kline, and every trade*, which is an ordinary thing to want.

```jsonc
"datasets": [{ "dataset": "klines", "variant": "1m" }, { "dataset": "trades" }]
```

**`@` is an ordinary instrument**, so cold-storing the venue-wide files and keeping a few instruments
on their own for simulation is one rule with both in it.

### What is refused

A definition that claims more than a venue publishes is refused with `400` and a `problems` list, each
naming the venue, the rule's position and, where one part is at fault, the field — so the editor can
put it where the choice was made. Two faults are refused rather than warned about, because both read
later as a decision rather than a mistake and arrive as an empty download noticed weeks afterwards:

- **a venue's rules opening with `exclude`**, which lets nothing through — subtracting from nothing is
  a no-op;
- **an empty list in a dimension**, which matches nothing, where leaving it out matches all of it;
- **a finer filter that does not fit everything a rule groups.** A rule naming markets or datasets
  is checked per `(market, dataset, variant)` it selects: `grains` that match nothing of one of them,
  or `@` where one has no venue-wide file in the grains the rule takes, would drop it in silence. The problem names each one it
  misses, which is what says where to split the rule. A rule naming neither markets nor datasets is
  read as "wherever this applies" and is not checked this way.

## Resolving one

**Three steps, in this order, because of where each dimension lives.** Market, dataset, variant and
grain are properties of the *pattern*; the instrument is a property of the *series*; the date is a
property of the *file*. So a lens picks patterns, then the series on them, then applies the dates —
the first two are folds over rows already in memory, and only the last touches the file table.

**A lens resolves to spans, not to a range.** Rules compose, so a later one can carve a hole in an
earlier one's: including 2019 to 2021 and then excluding 2020 leaves two spans, and collapsing them to
one range would hand back a year nobody asked for. The arithmetic is in the catalog's `lenses/spans.ts`.

**Resolved once and held for a minute**, dropped the moment the lens is edited — every page of a
listing would otherwise fold the whole series registry again (`lenses/scope.ts`).

## What a lens costs, and how far along it is

Nobody fetches everything, so the figure that decides a lens is its size, and it answers while
somebody is still choosing. **It is always exact, and never reads a file**: it is summed off the two
rollups, which hold files, bytes and what is still pending per month and are kept in step with every
write.

- **A venue nothing narrows** is summed off `rollup_venue` — a few hundred rows, and the same figures
  the surveys page reads, so the two can never disagree.
- **Anything narrower** — a market, a dataset, a grain, an instrument — is summed off
  `rollup_series` over the series the lens selects, one indexed range per series and span. A lens's
  bounds are months, which is the rollup's own grain.

Sampling is what this replaced, and it is worth saying why it had to go: trade volume is so uneven
between instruments that six series out of two thousand, scaled up, put bybit's 2021–2025 perpetual
trades at 4.4 TB where they are 1.9.

The date bounds are part of the price: a lens letting one year of a ten-year series through is sized
at one year.

**Progress comes from the same road.** The size carries `pending` and `pendingBytes` — the files not
yet downloaded — beside the totals, so a lens's progress never disagrees with its size.

## Reading through a lens

A consumer names its lens in an `x-catalog-lens` header. **No header is the whole catalog; an unknown
slug is a `404`, never the whole catalog in its place.**

**The listing** lists only what the lens lets through — see [Listings](CATALOG-API.md#listings).

**The contents** — `/contents/venues` and everything under it — narrow to the lens too:

- **Only series with a file inside the lens.** A seeded series nothing has been found for offers
  nothing, and a venue the lens lets nothing through from is not listed.
- **A shape's dates are its files', not the lens's.** A series the lens cuts reports the oldest and
  newest file it actually holds inside it — one indexed read per such series — so a shape under a
  lens ending `202012` says where its data stops rather than claiming the lens's last day.
- **The venue list is the lens's figures, for every venue at once**: files, bytes and pending are its
  size, its months the first and last with a file, and its series those holding a file inside it — all
  off the rollups, without reading a series row or a file. Where the lens takes whole venues, size and
  months come off `rollup_venue`, so they agree with every other figure for the venue.

## Who reads through one

**Several downloaders split the work by lens.** A file one of them reports as downloaded is no longer
pending for any other, so two downloaders through overlapping lenses would each skip what the other
fetched. Giving each its own, disjoint lens — one deployment per venue, say, each with its own
downloader — is how they are kept apart. Nothing in the catalog enforces it; it is how the
deployments are arranged.

**Readiness is decided against a complete lens.** A consumer that builds from what is on disk —
stocker, cold storage — works through a lens that is fully catalogued, and a unit of work is ready
once every file the lens lists for it is on disk. Whether a month is "closed" is never asked of the
catalog.

**A lens never scopes collection.** What prospector surveys is set by `PROSPECTOR_VENUES`; a lens only
narrows what a consumer reads.
