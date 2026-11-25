# A REST collector

What a collector of the venues' REST history has to fetch, how big that is, and what it has to cope
with. What each venue's API is lives in its doc, under `REST` in `docs/venues/<VENUE>.md`; the
venues side by side are in [docs/REST.md](../REST.md). This plan cites them and does not restate
them.

---

## Why REST, and where it sits

A venue can be collected from three places, preferred in this order:

| | | cost |
|---|---|---|
| 1 | **archives** — files the venue publishes | cheapest: one file is hours of an API |
| 2 | **REST history** — paginated endpoints | rate-limited; what is one file there is hours of pages here |
| 3 | **websocket** — live streams | dearest: what is not collected while it is down is gone |

**History only, public and free.** An endpoint that answers "as of now" is in scope only where
polling it is the sole way to have that dataset at all.

## What to fetch

### Backfills: history that goes back years, and the archive lacks

"At the limit" is the time to fetch all of it at the venue's rate limit; "stored" is the answers
gzip-compressed, as they travelled. How these are worked out is under *How the figures are worked
out* below. What each dataset reaches back to, and which instruments still answer, is in the venue
doc.

| venue | dataset | fetch before delisting | pages | at the limit | stored |
|---|---|---|---|---|---|
| [bybit](../venues/BYBIT.md#endpoints-that-serve-the-past) | funding | no | 16k | 2 min | 0.03 GB |
| | open interest, 5 min | **yes** | 789k | 1.8 h | 3.5 GB |
| | long/short account ratio, 5 min | **yes** | 316k | 44 min | 1.9 GB |
| | mark bars, 1 m | no | 1,111k | 2.6 h | 24 GB |
| | index bars, 1 m | no | 1,111k | 2.6 h | 24 GB |
| | premium bars, 1 m | **yes** — a delisted one's were zeros | 1,058k | 2.5 h | 7.4 GB |
| | spot bars, 1 m, 2021-07 → 2022-11 | no | ≤ 114k | 16 min | ≤ 2.2 GB |
| | historical volatility, hourly | — | few | — | small |
| [okx](../venues/OKX.md#endpoints-that-serve-the-past) | mark bars, 1 m | **yes** | 1,661k | 46 h | 8.5 GB |
| | index bars, 1 m | **yes** | ~1,576k | 44 h | 9 GB |
| | swap bars, 2020-01 → 2021-09 | **yes** | 128k | 3.5 h | 1.3 GB |
| [bitget](../venues/BITGET.md#endpoints-that-serve-the-past) | mark bars, 1 m | **yes** | 3,179k | 44 h | 12 GB |
| | index bars, 1 m | **yes** | 3,179k | 44 h | 9.5 GB |
| [kucoin](../venues/KUCOIN.md#endpoints-that-serve-the-past) | spot bars, 1 m, 2017-10 → 2022-12 | **yes** | ≤ 236k | 3 h | ≤ 9 GB |
| | futures funding | no | 19k | 24 min | 0.01 GB |
| | futures premium index, 1 m | not known | 6,736k | 84 h | 5.4 GB |
| [htx](../venues/HTX.md#endpoints-that-serve-the-past) | funding | **yes** | 3.9k | 1 min | 0.01 GB |
| [gate](../venues/GATE.md#endpoints-that-serve-the-past) | index bars, 1 m, of its option underlyings | — | ≤ 14k | 12 min | ≤ 0.5 GB |
| | option settlements | — | few | — | small |
| [binance](../venues/BINANCE.md#against-binances-own-archive) | futures bars and funding before the archive's first files (BTCUSDT: 2019-09 → 2019-12) | — | few | — | small |

**"Fetch before delisting" is a deadline, not a detail.** Where a delisted instrument answers
nothing, what is not fetched while it is listed cannot be fetched afterwards. That decides the
order: the "yes" rows first.

**Trades are no backfill.** No API serves them beyond a window; the archives are where trades are.

### Windows worth reading every so often

A window is lost as it rolls, so reading it is a schedule, not a backfill. The ones that carry what
no archive has:

| venue | dataset | window | read every | size |
|---|---|---|---|---|
| [gate](../venues/GATE.md#endpoints-that-hold-only-the-newest) | contract statistics, 5 min | 180 days | well inside 180 days | 180 days: 26.6k pages, 22 min at the limit, 33 GB as it arrives — uncompressed on the wire |
| | contract statistics, 1 h | 180 days | | 180 days: 2.2k pages, 2 min, 2.75 GB |
| | liquidation orders, the whole venue | about 11 months | | 330 days: ~8k calls, 7 min at the limit, 0.3 to 0.5 GB |
| [okx](../venues/OKX.md#endpoints-that-serve-the-past) | open interest and ratios, by instrument | 1,440 points | 5 days at 5 min | |
| | premium | 6 months | | 6 months: 1,296k pages, 36 h, 1.8 GB |
| [htx](../venues/HTX.md#endpoints-that-serve-the-past) | liquidation orders | 90 days, 2 hours a call, a contract at a time | | 90 days: 413k calls, 86 min at the limit |
| [binance](../venues/BINANCE.md#endpoints-service-by-service) | open interest, ratios, taker volume, basis | 30 days | | |
| [okx](../venues/OKX.md#endpoints-that-hold-only-the-newest) | open interest of every swap, now | a snapshot | as often as wanted | one call |

### The rest of the figures

| venue | dataset | records | pages | at the limit | stored | raw JSON |
|---|---|---|---|---|---|---|
| bybit | funding | 3.0M | 16k | 2 min (13 min at 20 a second) | 0.03 GB | 0.25 GB |
| | open interest, 5 min | 158M | 789k | 1.8 h (11 h) | 3.5 GB | 14.8 GB |
| | open interest, 1 h | 13M | 66k | 9 min (55 min) | 0.3 GB | 1.2 GB |
| | long/short ratio, 5 min | 158M | 316k | 44 min (4.4 h) | 1.9 GB | 14.2 GB |
| | mark bars, 1 m | 1,111M | 1,111k | 2.6 h (15.4 h) | 24 GB | 64 GB |
| | index bars, 1 m | 1,111M | 1,111k | 2.6 h (15.4 h) | 24 GB | 64 GB |
| | premium bars, 1 m | 1,058M | 1,058k | 2.5 h (14.7 h) | 7.4 GB | 58 GB |
| | spot bars, 1 m, 2021-07 → 2022-11 | ≤ 114M | ≤ 114k | 16 min (1.6 h) | ≤ 2.2 GB | ≤ 7 GB |
| okx | mark bars, 1 m | 498M | 1,661k | 46 h | 8.5 GB | 31 GB |
| | index bars, 1 m, one index a swap | 473M | 1,576k | 88 h as documented, 44 h as observed | 9 GB | 31 GB |
| | swap bars, 2020-01 → 2021-09 | 38M | 128k | 3.5 h | 1.3 GB | 4 GB |
| | premium, 6 months | 130M | 1,296k | 36 h | 1.8 GB | 10 GB |
| gate | contract statistics, 5 min, 180 d | 53M | 26.6k | 22 min; 53 h at 0.14 pages a second on one connection | 33 GB on the wire | |
| | contract statistics, 1 h, 180 d | 4.4M | 2.2k | 2 min; 4.4 h on one connection | 2.75 GB | |
| | liquidation orders, 330 d | 2M to 4M | ~8k calls | 7 min; 35 min as seen | 0.3 to 0.5 GB | |
| htx | funding | 0.35M | 3.9k | 1 min (16 min at 4 a second) | 0.01 GB | |
| | liquidations, 90 d | not known | 413k calls | 86 min (29 h at 4 a second) | not known | |
| kucoin | spot bars before 2022-12 | ≤ 354M | 236k | 2.9 h | ≤ 9 GB | ≤ 28 GB |
| | funding before 2023-01 | 0.15M | 2.2k | 3 min | — | 0.01 GB |
| | funding, all of it | 1.9M | 19k | 24 min | 0.01 GB | 0.13 GB |
| | premium index, 1 m | 674M | 6,736k | 84 h | 5.4 GB | 59 GB |
| bitget | mark bars, 1 m | 636M | 3,179k | 44 h | 12 GB | 45 GB |
| | index bars, 1 m | 636M | 3,179k | 44 h | 9.5 GB | 45 GB |
| | funding, 90 d | 0.2M | 3k | 3 min | — | 0.02 GB |
| binance | funding, every symbol at once | | 4,000 | | | |

### How the figures are worked out

They rest on the venue docs' measurements of 2026-10: their listings, page sizes and limits, and
the bytes of pages actually received.

- **Instrument-days**: the sum, over a venue's instruments, of the days each has existed — from the
  venue's listing where it carries dates (bybit, gate, htx, kucoin futures), and otherwise from the
  first bar of every instrument, one call each (kucoin spot, okx, bitget, bybit spot). The counts
  are under *The listings* in each venue doc. Where a venue forgets delisted instruments, they are
  not in the count — and not fetchable either.
- **Records** = instrument-days × records a day: 1,440 for 1-minute bars, 288 for 5-minute series.
- **Pages** = records ÷ the page size. **At the limit** = pages ÷ the limit.
- **Stored** = records × the gzip-compressed bytes per record of a page actually received.

**Assumed**, and so the softest numbers here:

- **Funding at 4 records a day** on average, between the 3 of an 8-hour contract and the 6 of a
  4-hour one. Half of bybit's and kucoin's contracts are on 4 hours.
- **Bars as dense**: every minute of an instrument's life counted. Kucoin's spot bars exist only
  for minutes that traded, so its figures are upper bounds, marked ≤.
- **One okx index for each swap.** The indices were not counted.
- **A delisted instrument counted as living to now** in the first-bar sweeps (bybit spot): an upper
  bound, marked ≤.

**The link, not the venue, sets the real time for most of it.** One connection does 1.5 to 4 pages a
second, a round trip being 250 to 700 ms. From the measuring machine 5 connections did 12.6 pages a
second of 1,500 bars, 10 did 27 small calls a second, and with nothing else on the line 64 did 130.
The exceptions, where the venue's limit binds first: okx (10 pages a second on bars), bitget (5 a
second on trade bars, 20 on mark and index), binance futures (4 pages of 1,500 a second).

---

## What the collector has to cope with

Its shape is the one the retired scribe (`services/.deprecated/scribe`) used for BitMEX: one
description per dataset over a generic runner, a budget paced against, pages fetched ahead and
written in order, resuming from what is already stored. Scribe's description held a path, a page
size, static parameters, a symbol resolver, a floor and the clock it is ordered by. Across these
venues a description also has to say:

- **its scheme**, of the five in [docs/REST.md](../REST.md#paging), and the names and units of its
  bounds;
- **which way it walks, and which way a page is ordered**;
- **its depth**: unbounded, a date, a number of days, a number of points — and so whether it is a
  backfill, a window to read every so often, or a snapshot;
- **what it is asked by**: a symbol, a pair and contract type, an index name, a family, or nothing
  — binance funding and gate liquidations return the whole venue;
- **where the records are** in the answer, and whether a record is an object or a row;
- **what ok looks like**, since several venues answer errors with HTTP 200;
- **which budget it draws on, and its cost**;
- **whether a delisted instrument still answers**, which decides if its history can wait.

**Direction sets how it resumes.** A backward walk has no natural resume point: what is new arrives
at the end it started from. A history walked backward is done once to its floor, and then followed
forward from its newest record — two walks of one dataset.

**Pacing** reads the budget where the venue reports it on every answer (binance, gate, kucoin,
bitget) and counts where it does not (bybit, okx, htx market data). A budget keyed by address and
instrument (okx) is paced per instrument. Scribe's several identities do not carry over: these are
public calls limited by address, and an account adds nothing. Addresses would.

**What stays a hook**, because it was met once:

- records sharing one instant across a page boundary (binance funding, all symbols);
- a window that silently returns less than it holds (gate liquidations, capped at 1,000 an hour);
- zeros that are padding (okx taker volume);
- bars only where there were trades (kucoin spot);
- a column order of its own (kucoin: open, close, high, low), and a volume that counts one side
  (kucoin's classic spot bars);
- a floor that is a date nobody states (binance spot trades).

## Open questions

- **Gate's archive gaps.** One perpetual, `SUN_USDT`, has months the archive does not hold and REST
  cannot serve ([GATE.md](../venues/GATE.md#known-gap-sun_usdt-2021-07-to-2021-09)). A sweep comparing
  each gate perpetual's months in the archive against its first and last file would find any
  others; it sizes a gate backfill against the real list, so it comes before one is designed.
- **Dated futures and options** were looked at, not sized: bars and settlements exist for them at
  bybit, okx and gate.
- **The number of okx indices**, which the index-bar figures assume to be one a swap.
- **Whether kucoin's premium index survives delisting**, which decides whether it can wait.
- **Binance Alpha**: whether its bars are wanted at all, and its limits, which are not known.
- **What limits binance's `/futures/data` and `fundingRate`, and htx's market data**: none refused
  at what the measuring link could send, so the pace there is the link's.
