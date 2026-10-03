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

**`*` holds rules about every venue, read together with each venue's own.** A lens whose only rule is
global reaches venues it never names — including ones added later.

**Includes minus excludes, in no order.** A lens lets through everything its includes match, less
everything its excludes match — `*` and the venue's own rules in one pool. Where a rule sits never
changes the result, so *everything up to a date, except books, except recent trades* is three rules in
any order. **An exclude always wins** over an include it overlaps: a carve-back ("except books — but
BTC's books") is written as a narrower exclude, not as a later include.

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

- **a venue whose rules include nothing**, which lets nothing through — an exclude only takes away
  from what an include lets in;
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

**A lens resolves to spans, not to a range.** An exclude can carve a hole in an include: including
2019 to 2021 and excluding 2020 leaves two spans, and collapsing them to
one range would hand back a year nobody asked for. The arithmetic is in the catalog's `lenses/spans.ts`.

**Resolved when it is saved, and stored.** What a lens lets through is kept as rows of `lens_series`:
a series, and a span of its dates, with two rows for a series the lens cuts a hole in. Every view through
a lens (the listing, the contents, the size, a report's check) reads those rows, and none of them
evaluates a rule. So a lens costs the same after a restart as an hour into a run.

- **Saving rebuilds the venues it changed.** A change to one venue's rules can only move that venue's
  series; a change to the `*` rules can move any, and rebuilds every venue. A save that changes only
  the name or the note rebuilds nothing.
- **New series are added, never rebuilt.** Prospector numbers series in order, so a lens records the
  newest it has looked at (`series_through`). **Every fifteen minutes, in the background**, each lens
  folds in the series past that, a few thousand at a time with requests answered in between — a
  venue's first walk creates them by the hundred thousand. **A request through a lens still catches up
  first**, so a lens is never behind the catalog; the background makes that a primary-key seek that
  finds nothing, nearly always.
- **A series prospector deletes** leaves its rows behind with no files, which lets nothing through.

The catalog writes `lens_series`, as it writes `lens`. Both tables are lenses, the one thing in the
database collection never decides.

## What a lens costs, and how far along it is

Nobody fetches everything, so the figure that decides a lens is its size, and it answers while
somebody is still choosing. **It is always exact, and never reads a file**: it is summed off the series
rollup, which holds files, bytes and what is still pending per series and month, kept in step with every
write.

- **A saved lens** is one query: its `lens_series` rows joined to `rollup_series` over the months each
  row's dates fall in. A lens's bounds are months, the rollup's own grain, so that is exact.
- **A definition being edited** has no rows yet, so it is resolved as it stands: a venue it takes whole
  is summed off `rollup_venue`, and anything narrower off `rollup_series` over the series it selects.

Sampling is what this replaced, and it is worth saying why it had to go: trade volume is so uneven
between instruments that six series out of two thousand, scaled up, put bybit's 2021–2025 perpetual
trades at 4.4 TB where they are 1.9.

The date bounds are part of the price: a lens letting one year of a ten-year series through is sized
at one year.

**Progress comes from the same road.** The size carries `pending` and `pendingBytes` — the files not
yet downloaded — beside the totals, so a lens's progress never disagrees with its size.

## Reading through a lens

A consumer names its lens in an `x-catalog-lens` header, or a `lens` query parameter. **Naming none is
the whole catalog; an unknown slug is a `422`, never the whole catalog in its place.**

**The listing** lists only what the lens lets through — see [Listings](CATALOG-API.md#listings). Its
walk takes each series in key order and reads only the ones the lens holds, and of those only the
files inside its spans.

**A report** through a lens settles only what the lens lets through; a key outside it is answered
`AccessDenied`. See [Reporting](CATALOG-API.md#reporting).

**The contents** — `/contents/venues` and everything under it — narrow to the lens too:

- **Only series with a file inside the lens.** A seeded series nothing has been found for offers
  nothing, and a venue the lens lets nothing through from is not listed.
- **A shape's dates are its files', not the lens's.** A series the lens cuts reports the oldest and
  newest file it actually holds inside it — one indexed read per such series — so a shape under a
  lens ending `202012` says where its data stops rather than claiming the lens's last day.
- **The venue list is the lens's figures, for every venue at once**: files, bytes and pending are its
  size, its months the first and last with a file, and its series those holding a file inside it. All
  of it is the same one query as the size, grouped by venue.

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
