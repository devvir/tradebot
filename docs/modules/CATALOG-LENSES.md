# Catalog lenses

A **lens** is a named selection of the catalog. Where one is in force, what it lets through *is* the
catalog as far as that request is concerned; the rows underneath stay complete and unfiltered.
Everything else in the catalog is a measurement; a lens is a decision, made entirely from what the
catalog holds.

It is how a reader of the catalog says what it wants without the catalog changing. The endpoints are in
[CATALOG-API.md](CATALOG-API.md#lenses); the editor is in [CATALOG-UI.md](../services/CATALOG-UI.md).

The catalog opens its database read-only: a lens written through its API is checked there and stored by
prospector through its private API; prospector also keeps `lens_member` current (see
[PROSPECTOR.md](../services/PROSPECTOR.md#lenses)).

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
identity is their position. There is no `PATCH` of a single rule; last write wins. `format` is `1`, the
one set of rules there is; left out, it means that.

**Three names, doing different jobs.** `slug` is what a reader is configured with and what every path
addresses, so it is stable; `name` is what a person calls it, free to change, and the slug where none is
given; `note` is what it is for. Addressing by `name` would mean renaming a lens reconfigures whoever
reads through it.

**Keyed by venue name**, never by id: an id names a *host*, and bybit publishes its books from a
second one.

**`*` holds rules about every venue, read together with each venue's own.** A lens whose only rule is
global reaches venues it never names — including ones added later.

**Includes minus excludes, in no order.** A lens lets through everything its includes match, less
everything its excludes match — `*` and the venue's own rules in one pool. Where a rule sits never
changes the result, so *everything up to a date, except books, except recent trades* is three rules in
any order. **An exclude always wins** over an include it overlaps: a carve-back ("except books — but
BTC's books") is written as a narrower exclude, not as a later include. A list of only excludes lets
nothing through, and so does a lens with no rules, which is what a new one starts as.

**A rule states only what it constrains.** An absent dimension means all of it:

| field | matched against |
|---|---|
| `effect` | `include` or `exclude` |
| `markets` | a list of market names, matched against a slice's market |
| `datasets` | a list of `{ dataset, variant? }`; an absent `variant` is every variant of that dataset |
| `grain` | `{ only }` or `{ prefer }` one of `monthly`, `daily`, `hourly`, `minutely` |
| `bundle` | `{ only }` or `{ prefer }` one of `instrument`, the files of one instrument each, and `market`, the market-bundle files (`@`) that hold every instrument of a market at once |
| `from`, `to` | months, `yyyymm`, inclusive, on the period a file covers; absent is open |

**A grain and a bundle are forms the same month can be published in**, and a rule takes them one of
three ways:

- **absent** — any form;
- **`only`** — that form and no other. Where a month is not published in it, the rule matches
  nothing of that month;
- **`prefer`** — any form, and of the forms a month is published in, that one alone where it is
  among them, and whatever there is where it is not. So one rule covers a venue whose datasets are
  monthly here and daily there, without anybody having to find out which.

```jsonc
{ "effect": "include", "datasets": [{ "dataset": "trades" }], "grain": { "prefer": "monthly" } }
```

**A rule that prefers both settles the bundle first**, then the grain within it. **Each include is
settled on its own and they add up**, so a second rule that takes the other form brings it back.
An exclude cannot prefer: it keeps nothing, so it has nothing to choose between.

A rule names only what it constrains because datasets, variants and grains are *added* over time: a
rule that leaves a dimension out absorbs an addition, where one enumerating every value would silently
stop covering it.

**A variant belongs to its dataset**, which is why the two travel as a pair: two flat lists could not
say *one length of kline, and every trade*, which is an ordinary thing to want.

```jsonc
"datasets": [{ "dataset": "klines", "variant": "1m" }, { "dataset": "trades" }]
```

**A rule never names an instrument.** What it selects is whole: every instrument a market publishes
in a bundle, or none of them.

**What a rule is written against** is every combination of venue, market, dataset, variant and grain
that has a series (`GET /lenses/options`). That list is counted afresh at most every five minutes, so a
dataset a venue has just begun to publish can take that long to appear in it.

### What is refused

A definition that is not one is refused with `400` and a `problems` list. Each problem names the venue
and the rule's position and, where one part is at fault, the field — so an editor can put it where the
choice was made. A problem with the definition as a whole names venue `''` and rule `-1`; one with a
venue as a whole, such as a venue that does not exist, names that venue and rule `-1`. Refused are:

- a definition that is not a document of venues, each with a list of rules;
- a `format` other than `1`;
- a rule that is not shaped as one: a field a rule does not have, an effect that is neither `include`
  nor `exclude`, a field that is not of its kind;
- a venue that does not exist (`*` aside);
- a grain or a bundle that is not one of the values above;
- an exclude that prefers a form;
- a bound that is not a month, or a range that ends before it starts.

**What a rule matches is never weighed.** A rule that selects nothing today, a venue whose rules
include nothing, a form taken alone that only part of what the rule names is published in — each may
be exactly what was meant, and where it was not, preferring the form says so. What a definition
selects is there to be looked at before it is saved: its size, and what it resolves to per venue — how
many slices and partitions, and the month spans its rules bound them to.

## Resolving one

**A lens is a list of whole partitions.** Market, dataset, variant, grain and bundle are the traits
of a *slice*; the date is a *partition's* month. A rule never reaches inside a partition, so each is
in or out whole.

**A partition is never decided alone.** A month of a dataset published in several forms — monthly and
daily, per instrument and for the whole market — is as many partitions, and they are siblings. What a
rule that prefers a form keeps of them depends on which are there, so the siblings are decided
together: each include keeps what it keeps of them, the keeps are added up, and what any exclude
matches is taken away.

**A lens's bounds resolve to spans, not to a range.** An exclude can carve a hole in an include:
including 2019 to 2021 and excluding 2020 leaves two spans, and collapsing them to one range would
hand back a year nobody asked for.

**Stored as what it lets through.** A lens's partitions are kept as rows of `lens_member`. Every view
through a lens (the listing, the contents, the size, a report's check) reads those rows, and none of
them evaluates a rule. So a lens costs the same after a restart as an hour into a run.

**A partition is in its lenses from the moment it exists.** Prospector takes a new partition into
every lens it belongs in, in the transaction that creates it, settling its siblings with it — the ones
already let through included. So a sibling arriving can take a partition *out*: a daily month let
through while it was the only form leaves when its monthly sibling appears, under a rule that prefers
monthly. A round every thirty seconds settles anything a lens has not looked at, which is ordinarily
nothing.

**When a lens's rules are saved, the save answers and the lens is worked out after.** It says the lens
was stored, and the lens is `updating` until it has been worked out — in one pass over every partition,
read once and decided in memory, with only the rows that differ written. Until that pass is done, its
partitions are those of the rules before.

- **A run of saves is worked out once.** Rules are stored one at a time, so somebody changing several
  saves the lens several times in a row. The pass starts five seconds after the last save, over the
  rules as they stand then.
- **A save that changes only the slug, the name or the note works nothing out.**

## What a lens costs, and how far along it is

Nobody fetches everything, so the figure that decides a lens is its size, and it answers while
somebody is still choosing. **It is always exact, and never reads a file**: every partition carries its
own files, bytes and what is still pending, kept in step with every write, and a lens is a list of
partitions.

- **A saved lens** is one query: its `lens_member` rows joined to their partitions and summed. It says
  too whether the lens is `updating`, in which case the figures are of the rules before.
- **A definition being edited** has no rows yet, so it is resolved as it stands, against the venue's
  slices and partitions, and the partitions it lets through are summed.

The date bounds are part of the price: a lens letting one year of a ten-year slice through is sized
at one year.

**Progress comes from the same road.** The size carries `pending` and `pendingBytes` — the files not
yet downloaded — beside the totals, so a lens's progress never disagrees with its size.

## Reading through a lens

A request names its lens in an `x-catalog-lens` header, or a `lens` query parameter where there is no
header. **Naming none is the whole catalog; an unknown slug is a `422`, never the whole catalog in its
place**, and so is a `lens` parameter given more than once.

**The listing** lists only what the lens lets through — see [Listings](CATALOG-API.md#listings). Its
walk takes each series in key order and reads only those of a slice the lens holds a partition of, and
of those only the files in the months it lets through. A partition asked for by name that the lens does
not let through lists nothing.

**A report** through a lens settles only what the lens lets through; a key outside it is answered
`AccessDenied` and goes no further. See [Reporting](CATALOG-API.md#reporting).

**The contents** — `/venues` and everything under it — narrow to the lens too:

- **Only series with a file inside the lens.** A seeded series nothing has been found for offers
  nothing. A venue's markets, shapes and instruments are those of these series alone, and a shape's
  `symbols` and `buckets` (its count of market-bundle files, `@`) count only them.
- **A shape's dates are its files', not the lens's.** A series the lens cuts reports the oldest and
  newest file it actually holds inside it, read off the file index, so a shape under a lens ending
  `202012` says where its data stops rather than claiming the lens's last day.
- **The venue list is the lens's figures, for every venue at once**: `files`, `bytes`, `pending` and
  `pendingBytes` are its size at that venue, and `firstMonth` and `lastMonth` the first and last month
  it holds a file in — the same one query as the size, grouped by venue. A venue the lens holds no file
  of is not listed. `series` counts the series dated inside the months the lens lets through for their
  slice, judged by their first and last dates alone, so `withFiles` and `total` are the same number.
  `withdrawn` and `hosts` stay the whole venue's.
- **A venue's partitions are the lens's partitions**, and no others.

**Pending is the file's, not the lens's.** A file reported downloaded through any lens is no longer
pending through any other, nor without one.

**A lens never scopes collection.** It narrows what is read through the catalog; what the catalog holds
is the same whatever lenses exist.
