# @tradebot/lenses

What a lens is: its rules, how they are evaluated, how a definition is checked and sized, and how a
lens and its members are stored. Every function that reads or writes takes the catalog's database
(`node:sqlite`) as its first argument.

A **lens** is a named selection of the catalog. Where one is in force, what it lets through *is* the
catalog as far as that reader is concerned; the rows underneath stay complete and unfiltered.
Everything else in the catalog is a measurement; a lens is a decision, made entirely from what the
catalog holds.

| Module | Exports | Writes |
|---|---|---|
| `store` | `lenses`, `lensNamed`, `putLens`, `editLens`, `dropLens`: a lens as a row, read, made, replaced and removed | `putLens`, `editLens`, `dropLens` |
| `members` | `admit`, `catchUp`: the rows of `lens_member`, what a lens lets through | both |
| `draft` | `problemsWith`, `lensSize`, `resolveSlices`, `resolvedSummary`, `lensOptions`, `lensNameIsSound`: what a definition would let through, and whether it can be stored | none |
| `spans` | `union`, of month spans | none |
| `vocabulary` | `GRAINS`, `BUNDLES` | none |

The functions that write are for whoever owns the database, and for nobody who only reads it.

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

**Three names, doing different jobs.** `slug` is what a reader is configured with and what every
lookup addresses (`lensNamed`), so it is stable; `name` is what a person calls it, free to change,
and the slug where none is given; `note` is what it is for. Addressing by `name` would mean renaming
a lens reconfigures whoever reads through it. A sound slug (`lensNameIsSound`) is lower-case letters,
digits and hyphens, two to 64 characters, not starting with a hyphen.

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
that has a series (`lensOptions`). That list is counted afresh at most every five minutes, so a
dataset a venue has just begun to publish can take that long to appear in it.

### What is refused

`problemsWith` answers what is wrong with a definition as a list of problems, and never throws. Each
problem names the venue and the rule's position and, where one part is at fault, the field — so an
editor can put it where the choice was made. A problem with the definition as a whole names venue
`''` and rule `-1`; one with a venue as a whole, such as a venue that does not exist, names that
venue and rule `-1`. Refused are:

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
selects is there to be looked at before it is saved: its size (`lensSize`), and what it resolves to
per venue (`resolvedSummary`) — how many slices and partitions, and the month spans its rules bound
them to.

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

## Stored as what it lets through

A lens's partitions are kept as rows of `lens_member`, so whoever reads through a lens reads those
rows and evaluates no rule, and a lens costs the same after a restart as an hour into a run.

**A partition can be in its lenses from the moment it exists.** `admit` takes a new partition into
every lens it belongs in, inside the caller's transaction — the one that creates the partition —
settling its siblings with it, the ones already let through included. So a sibling arriving can take
a partition *out*: a daily month let through while it was the only form leaves when its monthly
sibling appears, under a rule that prefers monthly. A lens whose rules cannot be evaluated is
reported and left as it was, and never fails the transaction.

**A lens records the newest partition it has looked at** (`partitions_through`). `catchUp` settles
the partitions past it, a given number at a time, each step one transaction that moves
`partitions_through` with it, so a restart or a crash resumes where it stopped.

**Storing new rules does not work them out.** `putLens`, and `editLens` where the definition
changed, store the lens and return it `updating`, its `partitions_through` set back to the start.
The next `catchUp` then works the whole lens out in one pass: every partition read once, decided in
memory, and only the rows that differ from the lens's own written. Until that pass is done, its rows
are those of the rules before. An edit that changes only the slug, the name or the note leaves its
working out where it stands. `dropLens` removes the lens and its rows in one transaction.

## What a lens costs

`lensSize` answers what a definition would put on a disk, whether or not it is ever saved: the
partitions it lets through, their `files` and `bytes`, and of those `pending` and `pendingBytes`, not
yet downloaded. **It is always exact, and never reads a file**: every partition carries its own
counts, and a definition is resolved as it stands against the venue's slices and partitions and
those counts summed. The date bounds are part of the price: a lens letting one year of a ten-year
slice through is sized at one year.

A lens never scopes collection. It narrows what is read through the catalog; what the catalog holds
is the same whatever lenses exist.
