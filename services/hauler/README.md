# Hauler

Brings catalogued venue files to disk, under canonical names.

Prospector establishes what every venue publishes; hauler asks it for a list of
URLs over the [catalog API](../../docs/modules/CATALOG-API.md) and fetches them.
It never discovers, never learns how a venue structures its archive, and never
mirrors a venue's hierarchy — what a file *is* decides where it lands.

**It holds no venue vocabulary.** Markets, datasets, variants and instruments
arrive already canonical, because translating a venue's own words into them is
prospector's job and stops inside prospector's adapters. Hauler asks in that
vocabulary and files what comes back under it.

```
<archives>/venue/market/dataset/YYYYMM/FL/symbol/
    venue|market|dataset|symbol|period[|part].ext

/data/archives/bitget/perp/klines,1m/202506/B/BTCUSDT/
    bitget|perp|klines,1m|BTCUSDT|20250601.zip
```

The full identity is in the filename, so a reader lists files and parses names
without learning where they live. The directories above are for narrowing a
search and for being able to look at the archive at all.

## What it does

- Works one **venue** at a time in parallel, and within a venue **month by
  month, dataset by dataset** — because the unit downstream is a
  `dataset + month` partition, and a partition is only useful once it is whole.
- Verifies every file against the size and etag the catalog supplies. A file
  already on disk and correct is confirmed rather than re-fetched, which is what
  lets an archive that is already there be adopted with no seeding step.
- Reports what would not download and what arrived wrong. It never tells the
  catalog what is true — prospector re-probes the venue and rules.
- States one fact per finished partition, and nothing else: everything about
  individual files already lives in the catalog.

## The shopping list

Fetching everything is not on the table, so hauler works from a list of what is
wanted — the only thing about hauler a person decides, and the only thing it
serves over HTTP.

```
GET    /wanted[?venue=gate]
PUT    /wanted   venue, market, dataset, [from], [to], [fixed], [prefer]
DELETE /wanted   venue, market, dataset
```

```sh
curl -X PUT -H "x-catalog-token: $CATALOG_TOKEN" \
     "localhost:$HAULER_PORT/wanted?venue=okx&market=perp&dataset=trades\
&prefer.scope=bucket&prefer.grain=monthly&from=202101"
```

**Canonical names, not the venue's own** — `perp` and `klines`, never
`futures_usdt` and `candlesticks_1m`. That is the same vocabulary the catalog
answers in, so nothing translates a want into anything. The API rejects names
outside the vocabulary and lists what is valid.

**A want says what it needs, not what a venue turned out to offer.** *The
smallest bar length, monthly if there is a choice, the venue-wide file if there
is one* keeps meaning the right thing when a venue drops an interval or starts
publishing daily; `1m monthly` written out fetches nothing the day it does, and
nothing reports it.

| | |
|---|---|
| `fixed` | **this or nothing** — a depth nobody publishes fetches no files |
| `prefer` | **this where there is a choice** — applied in key order, skipped where it would leave nothing |

Both are keyed by the level they constrain: `grain`, `scope`, or a level of the
dataset's own variant (`interval`, `depth`, `mode`, `aggregation`, `kind`).
Values are literals, or `min` / `max` where the level has a size — durations and
depths do, modes and aggregations do not. `ticks` sorts below any bar.

At startup each want is resolved against `GET /venues/:venue/shapes` into one
listing per shape it selects, and a want that selects nothing is named in a
warning — a want for something a venue does not publish is a typo as often as it
is a plan.

`from` and `to` bound the months; leave them out for as far as the venue goes.

The list lives in the facts database under `topic: archives:scope` with
`fact: wanted`, keyed by `venue + market + dataset` — one row per dataset of a
venue — with the months in `period` and the requirements in `meta`. It sits in
the same topic tree as the completions, so "what we intend to fetch" and "what we
have fetched" are one query. Restating a want replaces it, and adding one needs
no restart.

## Naming

`src/naming/` puts the catalog's fields in order and checks them. There is no
translation table and no venue-specific knowledge of any kind: the dataset
directory is the canonical dataset with its variant levels appended (`klines,1m`,
`books,400,incremental`), and the rest is the venue, the symbol, the period and
the extension exactly as the catalog stated them.

The catalog hands the variant over already named — `{ "depth": "400", "mode":
"incremental" }` — so nothing here splits a comma or decides which position means
what. The values are joined in the order they arrive, which is the order the
levels belong in.

What is left is the one duty a consumer of a vocabulary still owes — it checks,
and **refuses by name** rather than approximating. A market or dataset outside
the vocabulary, or a file the catalog could not place in a series at all, is
skipped and logged rather than filed: an invented name becomes a directory, and
a directory becomes something a reader trusts.

An empty `symbol` is one of those refusals. `@` is the catalog's own name for a
file carrying every instrument of a market; blank means it could not identify
the file, which is a different claim and must not be filed as though it were the
same one.

## Environment

| variable | | |
|---|---|---|
| `CATALOG_URL` | required | where prospector's API is |
| `CATALOG_TOKEN` | — | the secret it sends to the catalog and checks on its own API. **Empty turns both off** |
| `HAULER_VENUES` | all | comma-separated venues to haul |
| `HAULER_MARKETS` | all | comma-separated markets to haul, canonical (`perp`, `spot`, …) |
| `HAULER_DATASETS` | all | comma-separated datasets to haul, canonical (`klines`, `trades`, …) |
| `HAULER_FROM` | unbounded | narrows every want's span to no earlier than this, `yyyymm` |
| `HAULER_TO` | unbounded | narrows every want's span to no later than this, `yyyymm` |
| `HAULER_CONCURRENCY` | 8 | concurrent fetches per venue |

Page size and the cool-off after a disputed partition are constants in the
code, not env — neither trades off against anything a deployment would know to
tune, so exposing them would be surface with no decision behind it.

**These narrow the shopping list; they never add to it.** The list itself is the
standing intention — shared by every deployment that reads it, changed rarely,
and left alone by these five. What they decide is which slice of it *this*
deployment fetches: `HAULER_VENUES=gate` on one machine and
`HAULER_VENUES=okx,bitget` on another split one list across two deployments
with no coordination between them, and `HAULER_MARKETS`, `HAULER_DATASETS`,
`HAULER_FROM` and `HAULER_TO` extend the same rule to the rest of a want —
prioritise `klines` first, or take only a date range, without touching what is
actually wanted. Absent means no further narrowing on that field; a want's own
bounds are never widened past what it already says, only ever narrowed further.

`/data/archives` and `/data/shared` are fixed container paths; which host
directories sit behind them is the compose file's business.
