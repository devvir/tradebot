# Catalog — what is left

The move from **trucker** to **prospector + hauler**: one service establishing what every venue
publishes, another bringing it to disk. How each works is
[docs/services/PROSPECTOR.md](../services/PROSPECTOR.md) and
[docs/services/HAULER.md](../services/HAULER.md); this is only the work still outstanding.

Adopting trucker's 6.2M already-downloaded files is tracked in [../ROADMAP.md](../ROADMAP.md), not
here.


## Finishing the seed rebuild

The seeds now ship from `migrations/seeds/<venue>/{pattern,series}.csv`, read by one shared
`seed.ts`, and the two venues run in the ordinary `catalog` module. What remains:

**1. Run the passes to completion.** Both venues are seeded with every symbol crossed against every
pattern and no bounds at all, so the pass is what establishes which series are real and where each
runs from and to.

**2. Collapse bitget's inflated symbols** — see the pin below. This has no okx equivalent.

**3. Re-extract the seeds** from `series` and `pattern` once the passes finish, in the same shape
they already ship: the tips they end up with are worth more than the floors they started from.

**4. Record each seed's trust cut** — see "Refreshing an unindexed venue".

**5. Two temporary hooks are still in the code**, both marked `TEMPORARY`, both there to make a
brute-force pass affordable and both wrong as a steady state:

| file | change | put back to |
|---|---|---|
| `update.ts` | `updatePage` stops an **active** series once it has any file | remove the check and its `published` helper |
| `okx.ts` | `ruleOnFailure` answers `'drop'` on `404` | remove the hook — the 404/403 fact stays |
| `okx.ts` | `ruleOnSuccess` deletes `wip` between an answered date and a known `last` | remove the hook, the `held` module variable, and the `held = db` line in `getContext` |

**Not temporary, though it arrived with the last of those:** `ruleOnSuccess` takes the `Unsettled`
row rather than a bare path. A hook handed what the caller already knows is the better shape whatever
happens to the rules using it, and bitget's part-chaining reads `row.path` either way.

**The third one leaves a catalog that must not be kept.** It lets a tip cross periods nothing asked
about, so okx's rows in that database describe files nobody looked for. The bounds are extracted, the
okx data is dropped, and the venue runs again from scratch against the new seed — which is the plan
regardless, but this makes it mandatory rather than tidy.

**Order matters for the second one.** `'drop'` bypasses `CONFIRMATIONS` in `probe.ts`, and both
venues' backlogs still hold rows marked `confirmed` — worth 30 attempts each — from before generated
keys were recorded as `assumed`. Removing the hook while those rows remain multiplies the cost of
retiring them. Drain first, then remove.

**6. `PROSPECTOR_VENUES`** in `catalog`'s `.env` still lists only the five indexed venues. Unset it
when okx and bitget should survey in the deployment that matters.


## PINNED: bitget's seed inflates symbols, and must be collapsed

**Do not ship bitget's seed as a record without doing this.** okx needs no equivalent: measured
across the whole catalog, the only okx symbols that ever differed from their path did so by a suffix
the *market* appends — `-futureschain`, `-optionchain`, `-SWAP` — identical for every series of the
pattern, which is what a pattern is for. Nothing happens inside an okx name.

The seed carries **both** spellings of every renamed instrument as symbols in their own right —
`KAIAUSDT` gets 22 series and so does `KLAYUSDT` — because nothing available beforehand could say
which the archive actually uses, and guessing is what lost sixty series last time. Of the 4,065
symbols, **3,962 are venue-named**, **93 are archive paths the venue never named**, and 10 are
derived by rule and seen nowhere yet.

Right for discovery, wrong as a record, because it merges two genuinely different cases — see
[../venues/BITGET.md](../venues/BITGET.md), "Two different things look alike here". Where the archive
spelling was itself a bitget symbol, two series with adjacent ranges is the truth. Where it never
was, it is a `url_symbol` and one series is the truth; recording two leaves the catalog holding the
data under a name the venue does not list, while the name a consumer *would* ask for is deleted as
empty.

**128 `(market, path)` pairs are the candidates**, all of them 1:1, listed in
`case2-url-symbols.json`. The pass probes both halves of every pair, so whichever serves — per
dataset, measured — decides it.

So extraction gains a step okx does not have: each candidate pair is collapsed to
`symbol = A, url_symbol = B`, and only pairs where **both** spellings serve stay as two series.

**The venue publishes the mapping itself**, which the sweep did not know when it probed both halves.
`POST www.bitget.com/v1/mix/index/search/trade/coin` with `{"searchContent":"<term>"}` returns
`symbolDisplayName` — the listed name — beside `symbolCode`, the archive's path spelling, and a
`symbolId` of `<code>_<TOKEN>` carrying the token too. Checked against the pairs the sweep had
established: **agreement on every one still listed, no disagreements.**

It caps at 50 rows per query and needs a search term, so it has to be driven from the REST instrument
listing rather than enumerated. And it only knows what is listed **today** — 11 of 25 sampled pairs
were already beyond it, and `DEGENUSDT` has 566 files under `$DEGENUSDT` that no rule derives and no
endpoint will admit to. So it settles the mapping going forward, and the seed remains the only
witness for anything delisted.


## Ten bitget depth streams the index offers and the seed does not carry

**Deferred, not resolved.** Found by asking bitget's download index for every spot instrument under
its *slashless* canonical rather than the dropdown spelling the form accepts — 3.3M records, 12,681
distinct key shapes, of which 12 are absent from everything the seed knows. None of these are among
the 22 already parked under `market='unknown'`.

Each is a depth stream filed under the instrument's own bare canonical, while that same instrument's
candlesticks, trades and quotes are filed under a different spelling. Whether that is one stream or
two is what separates them, and the archive answers it — the legacy spelling either carries depth of
its own or does not:

| canonical | spelling of its other datasets | depth @ legacy | depth @ canonical | overlap |
|---|---|---|---|---|
| LIQUIDIUMUSDT | LIQUIDIUMTOKENUSDT | 2024-07-22..2025-01-27 | 2024-07-27..2026-08-17 | 6 months |
| MRSOONUSDT | SOONUSDT | 2024-07-27..2026-08-31 | 2025-04-25..2026-08-14 | 16 months |
| VELOUSDC | VELO1USDC | 2024-07-09..2024-09-06 | 2024-08-23..2026-08-17 | 2 weeks |
| KAONUSDT | AKROUSDT | 2024-07-09..2025-02-13 | 2025-02-12..2026-06-24 | 1 day |
| TXUSDT | COREUMUSDT | 2024-07-09..2026-03-05 | 2026-03-06..2026-08-21 | none |
| CATEUSDT | CATENEWUSDT | none | 2024-07-27..2026-08-17 | — |
| RBTCUSDT | RBTCNEWUSDT | none | 2024-09-23..2025-10-20 | — |
| RUNESXUSDT | RUNESXBITCOINUSDT | none | 2024-10-12..2025-07-08 | — |
| SOPHUSDC | SOPHNEWUSDC | none | 2025-05-28..2026-08-17 | — |
| SPACEUSD1 | SPACENEWUSD1 | none | 2026-01-23..2026-08-17 | — |

**The bottom five, plus TXUSDT and KAONUSDT, look like the ordinary case.** One instrument, depth
spelled differently from its other datasets — either for its whole life, or handed over at a rename
boundary. That is a `url_symbol` on the depth series and nothing more, which is the point of holding
`url_symbol` on the series rather than the instrument.

**The top three overlap for months**, so for that period two depth streams were being written for one
listed instrument. That is the same shape as the AXLUSDT family already parked under
`market='unknown'`, and nothing yet says which of the two a consumer asking for the instrument should
be given.

**One twelfth shape is not part of this**: `kline/TRXUSDT/TRXETH_SP_1min_20220117.zip`, a single
object in TRXUSDT's directory named for TRXETH, reported by the index under "TRX/USDT". One file,
reads as a misfiling rather than a stream.

TXUSDT additionally showed `depth/TXUSDT/1/TXUSDT_1_DATE.zip` from 2026-08-18 — era 3's depth naming,
so the same stream continuing under the era-3 pattern, and it needs its own series exactly as every
other era-3 depth series does.

**Nothing here is in the seed CSVs.** Whatever is decided, the top three and the bottom seven are
decided separately.


## Refreshing an unindexed venue

**Planned, not built.** Recorded so the shape is agreed before anyone needs it.

An indexed venue heals by re-walking its index. okx and bitget have none, which is why both seeds
were unfixable in place and had to be rebuilt from scratch — a run measured in days. That is the
right cost once and the wrong cost annually.

**A completed seed makes the second time cheap, because it answers categorically.** It did not
sample: it asked about every period of every series across the whole archive, so what it holds is an
inventory rather than a pair of dates. Nothing below its horizon can change — a venue does not
publish 2019 files in 2027 — so a refresh has no reason to ask about that history again.

**So a refresh is an update with a lowered tip, and nothing else.** Pick a **trust cut** a clear
month below the day the seed ran — 2026-08-01 for the current bitget seed — and set every series' tip
there. Generation then covers the cut to today, which is exactly the ordinary update path over a
wider window, and the margin absorbs a venue publishing late.

Two things it recovers that a normal pass cannot:

- **Files the tip ratcheted past.** A gap longer than `OVERDUE_DAYS` is otherwise lost for good on
  these venues; a refresh asks about it again.
- **A `first` that is still NULL**, where the series began publishing after the seed and
  reconciliation only ever fills a missing start from what was found.

What it does not recover is anything below the cut, which is the deliberate trade: a full re-seed
remains the only way to revisit the deep history, and there is no known reason to.

**The cut belongs to the seed, not to the calendar.** It is a fact about when that inventory was
taken, so it is recorded alongside the seed rather than recomputed — a later refresh moves it forward
to a month below *its* own run.


## Hauler

Outstanding, in order:

**1. The first haul**, through `backfill-20` into `/data/tradebot/archives`.
Most of that range is already on disk, so the first pass is mostly
verification. Any failure shows up against files that are already known to be
correct.

**2. Look at what the pass did not touch.** Every file the catalog lists gets
the pass's date as its modification time. A file under the archive root with an
older date is one nothing listed: misfiled, withdrawn, or junk.

**3. Then the tools cold scripts, and stocker**, both on hauler's layout.
Trucker goes after them.

**What needs watching is the seam.** Prospector owns what exists, hauler owns what is on disk, and
neither writes the other's conclusions — so a disagreement is supposed to stay visible rather than be
resolved by whichever wrote last. Nothing has made the two disagree yet, which means the behaviour is
designed but unobserved.
