<!-- ─────────────────────────────────────────────────────────────────────────────
     Planning. Live scratch, not a description of anything that exists.
     Cut what is settled into the real docs; delete the file when nothing is left.
     ───────────────────────────────────────────────────────────────────────── -->

# Lenses — what is still open

A **lens** names a slice of the catalog, and where one is in force, that slice
is what the catalog is. The format, the endpoints and the header that puts a
lens in force are documented in the
[catalog API](../modules/CATALOG-API.md#lenses). This file holds only what is
not settled yet.

## The editor

### Two things the format can express and should warn about

**A definition that opens with `exclude` sees nothing.** Evaluation starts from
the empty set, so subtracting from it is a no-op and every later rule has nothing
to build on. It is legal and it is almost never meant; the editor should say so.

**An empty rule list and an absent venue are the same thing** — that venue is not
in the lens. Worth stating so an empty array is not read as "everything".

### Deliberately left out

**Instruments resolved from a live list**, such as "everything listed today",
stored with their provenance so the editor could show `listed · 1,284 · 23 Sep`
with a refresh instead of 1,500 rows. The mechanism is sound but it is a
different *kind* of rule from the rest: every other dimension absorbs additions
safely, while a resolved list is a claim about a moment that quietly stops being
true as instruments are delisted. It also complicates every update path.

Not now. `instruments` stays a plain list, or absent for all of them. Revisit
when something actually wants it.

## Open questions

### 1. Which other endpoints honour the lens

The bucket listing honours `x-catalog-lens`, and it is what hauler reads.
Nothing else does yet. Applying the lens must never be silent: a header that
changes every number turns "why does the catalog say three files" into a
debugging session.

| endpoint | under a lens | cost | settled? |
|---|---|---|---|
| `/venues/:venue/files`, `/pending` | filtered | series-level filter, then the usual paging | yes, not built |
| `/contents/*` (markets, shapes, symbols) | filtered | cheap: folds over the series registry, already in memory | yes, not built |
| `/status` | **unfiltered**: it reports venues and passes, not data | — | leaning |
| `/venues/:venue/months` | unclear, see 2 | needs a file scan under a filter | **open** |
| `establishedAt`, runs, surveys | unfiltered: facts about passes, not about data | — | yes |

The UI is meant to be a lens consumer too: picking a lens in the contents view
shows the catalog through it, with real counts and sizes, before a client is
pointed at it.

### 2. What a month means under a lens

`month` is a rollup keyed by venue and month — it cannot be filtered. Two
consequences:

- A lens's **size** cannot come from it unless the lens takes whole venues.
  That is already how lens sizing works: rollup where it applies, counted for
  small selections, estimated beyond that.
- **`closed` / `open` months** are worse. A month is closed when nothing among the
  files the catalog holds is still pending. Under a lens that should mean
  "nothing the lens can see is pending", which is a different question and a
  file scan to answer. Options: leave months unfiltered and document it; or compute
  them per lens and accept the cost; or keep a rollup per (lens, venue,
  month), which is a cache to invalidate every time a lens changes.

### 3. Many readers, one downloader

Several clients with different lenses against one catalog is the expected shape
— hauler fetches, cold storage keeps a narrower slice, a partition builder reads
something else again. Lenses serve that directly, because they only narrow
*reading*.

**One thing is not a read: `downloaded_at`.** It is a property of a file rather
than of a consumer, so it belongs to whoever fetches. With one downloader that is
exactly right, and every other client reads its slice without touching it.

Two downloaders against one catalog is the case that breaks: a file fetched by
one reads as downloaded to the other, which never had it. Then `pending` is wrong
for both and the fix is download state per consumer — a bigger change than this
document, and worth doing only when a second downloader actually exists.

**Proposal: one catalog, one downloader, any number of readers.** Worth stating in
the API docs, since nothing in the schema enforces it.

### 4. Does a lens ever constrain collection?

Read-scoping saves the *downloader* time and disk, which is the stated motivation.
It saves prospector nothing: it still walks and probes everything.

Collection-scoping is a separate, larger idea — and only worth it on venues whose
keys are probed one at a time (bitget, okx), where "only instruments listed today"
would cut millions of requests. It also costs the thing this service exists for:
a catalog that stopped asking about delisted instruments would never know when
they stopped.

**Not now.** Worth writing down so the two ideas stay apart.
