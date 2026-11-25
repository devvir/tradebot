# REST: the venues' APIs side by side

What the seven venues' public REST APIs serve of the past, compared: how deep each goes, what is
only a window, how each limits, pages and answers. Everything here needs no key and costs nothing.

**This is the comparison, not the account.** Each venue's API — every endpoint, its record, its
errors, and which statements were seen and which only documented — is under `REST` in its own doc:
[binance](venues/BINANCE.md#rest), [bybit](venues/BYBIT.md#rest), [okx](venues/OKX.md#rest),
[gate](venues/GATE.md#rest), [htx](venues/HTX.md#rest), [kucoin](venues/KUCOIN.md#rest),
[bitget](venues/BITGET.md#rest). The figures are those measured there, in 2026-10, from one
machine.

**Two words carry most of it.** *Deep* is history from the instrument's first day, or years of it.
A *window* is the last so many days or points and nothing older.

---

## Deep history the archive does not have

Each venue's API set against that venue's own archive, under *Against … own archive* in each doc.

| venue | funding | open interest | mark and index bars | trade bars before the archive | other |
|---|---|---|---|---|---|
| binance | in the archive from 2020-01; REST from 2019-09 | in the archive | in the archive | BTCUSDT futures, 2019-09 → 2019-12 | — |
| bybit | **deep** | **deep, 5 min, from 2020-08** | **deep** | spot, 2021-07 → 2022-11 | long/short ratio, volatility |
| okx | 3 months | 1,440 points | **deep, from 2020 / 2018** | swaps, 2020-01 → 2021-09 | — |
| gate | 180 days | 180 days | index of 12 option underlyings, from 2022 | — | option settlements |
| htx | **deep** | 200 points | 2,000 points | — | — |
| kucoin | **deep, from 2020** | 6 days at 5 min | below 8 h from late 2024; 8 h from 2021 | **spot, 2017-10 → 2022-12** | premium index, from 2020 |
| bitget | 90 days | now only | **deep** | — | — |

- **Deep history over REST is mostly derived prices**: mark and index bars at four venues, funding
  at three, open interest at one.
- **Trades are not history over REST** but at binance spot: elsewhere a window of 2 days to 6
  months by venue, or only the newest. Binance's spot trades reach back to 2022-09-02, short of its
  archive.
- **A delisted instrument answers nothing** at okx, htx, bitget and kucoin's spot. At bybit it
  keeps its bars and funding and loses its open interest and ratios. At kucoin a delisted futures
  contract still answers bars and funding.

## What is only a window

Each is the last so many days or points; older is refused or empty.

| venue | what | how much |
|---|---|---|
| binance | open interest, long/short ratios, taker volume, basis | 30 days |
| | futures trades | 2 days |
| | option exercise records | 6 to 9 months |
| bybit | option delivery prices | the last 50 |
| okx | funding, trades, insurance fund, deliveries and settlements | 3 months |
| | premium | 6 months |
| | open interest and ratios, by instrument | 1,440 points: 5 days at 5 min, 60 days at 1 h; daily since 2024-02 |
| | open interest and ratios, by currency | 2 days at 5 min, 180 days at 1 d |
| | liquidations | under a day |
| gate | spot and futures bars — trade, mark, index | 10,000 points: a week at 1 m |
| | funding, contract statistics, futures trades, premium index | 180 days |
| | liquidation orders | about 11 months |
| | spot trades | 30 days |
| htx | spot bars; mark, index, premium, estimated-rate and basis bars | the last 2,000 points |
| | liquidation orders, settlements | 90 days |
| | open interest | 200 points |
| kucoin | futures bars below 8 hours — trade, mark, index, premium | since late 2024: 1-minute from 2024-12 |
| | index at 1 second, with constituents | about 100 days |
| | open interest | 6 days at 5 min |
| bitget | funding, trades | 90 days |
| | recent bars (`candles`), interest rate | a month |
| | liquidations | 3 days |
| | ratios, taker volume | 30 points |

**Gate's contract statistics are the richest record of the seven** — open interest, mark price,
long/short ratios and liquidation totals in one row every 5 minutes — for 180 days.

## What no REST API gives

- **Liquidations** at binance, whose endpoint answers 404, and at bybit and kucoin, which document
  none.
- **Open interest finer than a day and older than six months**, anywhere but bybit.
- **Open interest as a history** at bitget: the value now is all there is.

---

## The limits

| venue | the budget | keyed by | reported | when it is spent | back after |
|---|---|---|---|---|---|
| binance | weight a minute for each service: 6,000 spot, 2,400 both futures together, 400 options | address | used so far: `x-mbx-used-weight-1m` | 429, `-1003`, `Retry-After` | the minute's turn |
| bybit | 600 calls per 5 s for the host | address | nothing | 403, plain text | the next call |
| okx | each endpoint its own, per 2 s: 20 bars, 20 mark bars, 10 funding, 10 open interest | address; some by address and instrument | nothing | 429, `50011` | 1 to 2 s |
| gate | 200 calls per 10 s for each endpoint | address | limit, remaining, reset | 429, `TOO_MANY_REQUESTS` | 2 s |
| htx | 240 calls per 3 s for reference data (120 on the coin-margined tree); market data not refused at 130 a second | address | limit, remaining, reset — on reference data only | **HTTP 200**, `err_code 1032` | the 3 s window's turn |
| kucoin | 2,000 weight per 30 s for every public call on both hosts | address | limit, remaining, ms to reset | 429, `429000` | the 30 s window's turn |
| bitget | each endpoint its own, per second: 20 for most, 5 for trade bars, 1 for ratios | address | remaining this second | 429, `"code":"429"` | the next second |

- **Every limit is by address, and none was seen to ban.** The longest wait was a minute, at
  binance, which alone documents a ban, for going on after a 429.
- **Three report nothing on the calls that matter** — bybit, okx, and htx's market data. Four
  report the budget on every answer: binance, gate, kucoin, bitget.
- **A budget keyed by address and instrument is one per instrument** (okx funding, open interest,
  statistics): a sweep of the venue is limited by how many instruments it asks about at once.
- **Budgets that look separate can be one** (binance's two futures hosts, kucoin's two hosts), and
  ones that look shared can be separate (okx and bitget, endpoint by endpoint).
- **A refusal is not always a status**: htx says it in the body of a 200.

## Paging

| scheme | where |
|---|---|
| **forward by time** — "from here, the next N" | binance; bybit bars; htx swap bars; gate; kucoin futures bars |
| **backward by time** — "the N before here" | okx, all of it; bitget; bybit funding; kucoin spot bars and funding; binance `/futures/data` |
| **by id** | binance spot trades |
| **by page number**, total stated | htx funding and settlements; bitget funding |
| **by cursor** | bybit open interest, ratios, instruments |

Two more are not paging at all: **the fixed window**, the last N points with no way to move it (htx
spot and derived bars, htx and bitget ratios, okx's 1,440 points), and **the snapshot**.

- **Order inside a page is separate from direction**: bybit walks bars forward and returns each
  page newest first.
- **A `limit` over the maximum** is silently capped at bybit and okx and refused at gate; at
  binance, htx and bitget it depends on the endpoint.
- **Bounds are seconds** at gate, htx and kucoin spot, and milliseconds elsewhere.
- **Errors come with HTTP 200** at bybit, okx and htx, for some at kucoin, and from binance's
  `fundingRate`.

## Where they answer from

From the one machine that asked:

| venue | in front | behind it | fresh connection | answer, small call | failures |
|---|---|---|---|---|---|
| binance | CloudFront, Barcelona; `dapi` none | Tokyo for `dapi`; not said for the rest | 180 ms; `dapi` 480 | 240 ms | 0 of 2,629 |
| bybit | CloudFront, Barcelona | not said | 130 ms | 187 ms | 0 of 2,943 |
| okx | Cloudflare, Madrid | Tokyo, by its header | 140 ms | 270 ms | 0 of 2,174 |
| gate | none | AWS Tokyo | **690 ms** | 231 ms | 0 of 717 |
| htx | CloudFront, New York (spot); EdgeOne (derivatives) | not said | 130 to 300 ms | 243 ms | 0 of 4,238 |
| kucoin | Cloudflare, Madrid | not said | 150 ms | 266 ms | 0 of 1,384 |
| bitget | Cloudflare, Madrid | not said | 130 ms | 259 ms | 0 of 979 |

**Nothing failed**: no timeout, no 5xx, no dropped body in some 15,000 calls at up to 290 a
second; every refusal was one asked for. **Nothing is fast either**: an answer takes a quarter of a
second at best, so one connection is worth about four pages a second. Gate alone makes a new
connection dear.

## Their documentation

| venue | what it is | read by a script |
|---|---|---|
| binance | spot: markdown on GitHub; futures and options: a site behind a challenge, with each endpoint's notes in binance's connector repository | spot only |
| bybit | static pages, current, every parameter stated | yes |
| okx | one complete page, every endpoint with its limit and its rule | yes |
| gate | general rules and changelog on the site; the endpoint reference in its SDK repository | the SDK |
| htx | older static pages; the current portal a script | the older pages |
| kucoin | an index of every page as markdown, each stating its pool and weight | yes, the best of the seven |
| bitget | a script serving one page everywhere, its content OpenAPI documents bundled in the site's scripts | by taking the site apart |
