# Venue Data Sources

Where each venue's data comes from, what each source contains, and therefore what
`hoarder` must capture over WebSocket.

> **Parked 2026-07-27.** WebSocket collection and `hoarder` are on hold. Everything verified
> so far is below; `hoarder` builds and its BitMEX path is production-equivalent, but its
> channel lists for the four new venues are **provisional and known to contradict these
> findings** — see *State of play*. Resume from *Next steps*.

## Why this document exists

**Collect any and all data.** Which markets are worth trading is an open question the
simulator exists to answer, so nothing is filtered on a hunch about what will be
profitable — every market that persists does so because someone profits from it, and
which ones suit us is decided from data, not assumption.

**WebSocket is the source of last resort.** Realtime data lost is gone forever, and WS
builds history one message at a time — a full day of drip-feed before a daily bucket can
be sealed, unrecoverable after an outage. Bulk files and REST hand over years at once and
keep working going forward.

**But WS still starts now.** Its value is realism that cannot be backfilled: event-level
sequencing, sub-second timing, fields no archive carries. The sooner it starts
accumulating, the sooner there is enough to train against. So WS collects what the other
two sources genuinely cannot supply — and that set is decided per venue, per table, by
comparing actual payloads.

Source priority: **bulk download → REST → WebSocket.**

## Data priorities

1. **trade** — the main table by far. Price evolution and volume; enough to build OHLCV
   bins for charting and indicators.
2. **instrument** — funding, volume, open interest, interest rate, mark/index price,
   whatever each venue uses to drive liquidation, settlements.
3. **quote** — top of book. Especially valuable where no historic book data exists.

## Status

| Venue | Bulk | REST | WS payloads captured | Conclusion |
|---|---|---|---|---|
| BitMEX | — | — | already collected in production | unchanged |
| Kraken | trades only (local copy) | trades verified | trade, ticker, instrument, level3 (docs) | trade: **REST wins**; book: **WS only** (L2; L3 skipped — auth) |
| Bybit | `public.bybit.com` enumerated + sampled | not checked | publicTrade, tickers, orderbook.1 | trade: **archive wins**; instrument: **WS only** |
| OKX | trades CDN verified; L2 (local, misfiled) | not checked | trades, tickers, funding-rate, open-interest, mark-price, bbo-tbt, instruments | trade: **archive wins**; book: bulk exists at 1/s |
| Binance | Vision enumerated + sampled | depth snapshot needed for books | spot + futures verified | trade + instrument: **archive wins**; book: **WS diffs + REST snapshots** |

Everything below marked *verified* was observed directly — a local file inspected, or a
live frame captured. Anything not verified is called out as such.

---

## Kraken

### Bulk — `TimeAndSales_Combined` (verified, local copy)

1,119 pairs, 46 GB unzipped; `XBTUSD.csv` alone 2.7 GB.

```
1381095255,122.0,0.1        ← unix seconds, price, volume
```

Three columns, no header. Missing `side`, `ord_type`, `trade_id`. Timestamps are whole
seconds — sub-second *timing* is lost, though intra-second **ordering may survive as row
order** (unconfirmed; worth testing against REST for a known second).

Coverage `2013-10-06` → `2025-12-31`. This export is a static snapshot; Kraken also
publishes per-quarter zips, **not yet downloaded**, which likely close the recency gap.

### REST — `GET /0/public/Trades` (verified)

```
["64486.50000","0.00020532",1785059090.567933,"s","l","",104270321]
   price          volume      time (µs)      side type misc trade_id
```

`since=0` returns from `2013-10-06T21:34:16.090795Z` — the first trade ever, at
microsecond precision. 1000 trades per call.

### WS — `trade` channel (verified)

```json
{"symbol":"BTC/USD","side":"sell","price":64458.1,"qty":0.00017873,
 "ord_type":"limit","trade_id":104270518,"timestamp":"2026-07-26T10:04:05.938963Z"}
```

### Conclusion — trades come from REST

Field by field, WS carries **nothing REST lacks**: side, order type, trade id and
microsecond timestamps are in both. REST additionally reaches back to 2013. The WS trade
channel is therefore redundant for Kraken.

*(This was previously asserted before the WS payload had been seen. It now holds because
the two payloads above were compared directly.)*

### Other Kraken channels (verified)

- **`ticker`** — the quote analogue: `bid, bid_qty, ask, ask_qty, last, volume, vwap, low,
  high, change, change_pct, trades, timestamp`. One frame per change, µs timestamps.
- **`instrument`** — a metadata snapshot (assets and pairs: precision, margin rate,
  status, collateral value), not a time series. Reference data, not history.

- **`level3`** — order-by-order book: every resting order with `order_id`, `limit_price`,
  `order_qty` and an RFC3339 timestamp, streamed as `add` / `modify` / `delete` events.
  Strictly deeper than any L2 feed and **not obtainable historically anywhere**.

  **It is authenticated** — "requires an API token to subscribe". Depths 10 / 100 / 1000,
  max 200 symbols per connection, rate-unit cost 5 / 25 / 100 per subscription. That
  collides with hoarder's deliberate no-credentials design (see below).

Kraken's bulk offering is trades only; no book history was found. So for Kraken the book —
at either L2 or L3 — exists only as a live stream.

---

## Bybit

### Bulk — `public.bybit.com` (verified by enumeration + download)

Five categories. Two are live and large, three are abandoned:

| Path | Symbols | Granularity | Coverage | State |
|---|---|---|---|---|
| `trading/{SYM}/` | **1,818** | daily file | BTCUSDT `2020-03-25` → `2026-07-25` | **current, daily** |
| `spot/{SYM}/` | **1,053** | monthly → daily | BTCUSDT `2022-11` → `2026-07-25` | **current, daily** |
| `premium_index/{SYM}/` | 11 | 1-min OHLC | `2019-10-01` → `2020-03-10` | **abandoned 2020** |
| `spot_index/{SYM}/` | ~10 | 1-min OHLC | `2019-10-01` → `2020-03-17` | **abandoned 2020** |
| `kline_for_metatrader4/{SYM}/{year}/` | ~8 | kline | 2020– | not inspected |

**Perp trades** — `trading/BTCUSDT/BTCUSDT2026-07-25.csv.gz`, 15.4 MB gz, 442,591 rows/day:

```
timestamp,symbol,side,size,price,tickDirection,trdMatchID,grossValue,homeNotional,foreignNotional,RPI
1784851200.0547,BTCUSDT,Buy,0.038,65065.80,ZeroPlusTick,d6b9a5ac-3439-5cea-b590-fd245e5b3992,2.4725004e+11,0.038,2472.5004,0
```

Note the timestamp: `1784851200.0547` — **sub-millisecond**, finer than the WS feed's
integer-millisecond `T`. Carries `tickDirection`, a UUID `trdMatchID`, `RPI`, and derived
notionals.

**Spot trades** — naming changes mid-series (`BTCUSDT-2022-11.csv.gz` monthly early,
`BTCUSDT_2026-07-25.csv.gz` daily now), and the schema is different from perps:

```
id,timestamp,price,volume,side,rpi
1,1784937600662,64142.5,0.00016,buy,0
```

Millisecond timestamps, integer id, no tick direction.

**Abandoned series** — `premium_index` held 1-minute OHLC of the premium index
(`start_at,symbol,period,open,high,low,close`) and `spot_index` the same shape for index
price. Both stop in March 2020, so neither is a source for current instrument-class data.

### WS — verified

```json
publicTrade.BTCUSDT  {"T":1785060230817,"s":"BTCUSDT","S":"Buy","v":"0.001","p":"64474.20",
                      "L":"PlusTick","i":"f520fc20-…","BT":false,"RPI":false,"seq":715964329311}
orderbook.1.BTCUSDT  {"s":"BTCUSDT","b":[["64474.1","1.4"]],"a":[["64474.2","7.108"]],"u":4030692,"seq":715964319629}
tickers.BTCUSDT      {"symbol":"BTCUSDT","tickDirection":"ZeroMinusTick","markPrice":"64475.28",
                      "indexPrice":"64510.19","openInterest":"57733.175","openInterestValue":"3722362623.41",
                      "fundingRate":"0.00001534","nextFundingTime":"1785081600000","fundingIntervalHour":"8",
                      "fundingCap":"0.005","turnover24h":…,"volume24h":…,"bid1Price":…,"ask1Price":…}
```

### Conclusion

- **trade — the archive is at least as good as the WS feed.** Field by field, bulk carries
  everything WS does (`tickDirection` = `L`, `trdMatchID` = `i`, `RPI`) at *finer* timestamp
  precision, daily, for 1,818 perp symbols back to 2020. WS adds only `seq` (sequence
  number) and `BT` (block-trade flag). Unless `seq` matters for ordering guarantees, the WS
  trade channel is close to redundant here.
- **instrument — `tickers` is the richest instrument-class payload of any venue surveyed**:
  mark price, index price, open interest and its USD value, funding rate, next funding time,
  funding cap and interval, 24 h volume/turnover, plus BBO. The two archive series that
  might have covered part of this were abandoned in 2020, so unless REST serves history
  (**not yet checked** — `/v5/market/funding/history` and open-interest endpoints exist),
  this must be captured live and permanently.
- **book — keep collecting over WS.** No book history was found on `public.bybit.com`; see
  the provenance note below about the local L2 file.

### ⚠ The local files in `/storage/tradebot/.tmp/bybit` are OKX data, not Bybit

Three independent signals agree:

| Evidence | Local file | Bybit's real format | OKX |
|---|---|---|---|
| Instrument naming | `BTC-USD-SWAP` | `BTCUSDT` / `BTCUSD` | `BTC-USD-SWAP` ✓ |
| Field name for it | `instId` / `instrument_name` | `symbol` / `s` | `instId` ✓ |
| Trades schema | `instrument_name,trade_id,side,price,size,created_time` | `timestamp,symbol,side,size,price,tickDirection,trdMatchID,…` | exactly this ✓ |

The third is decisive: `okx-dump`'s documented OKX trade schema is *trade_id, side, size,
price, created_time* — the local header, field for field.

**So the downloadable 5000-level L2 belongs to OKX, not Bybit.** No book history was found
anywhere on `public.bybit.com`. The measurements stand, re-attributed: 1 record/second, 96
snapshots + 86,304 updates/day, 5000 levels with per-level order counts.

---

## OKX

### Bulk — `www.okx.com/cdn/okex/traderecords/` (partially verified)

URL pattern, from the `okx-dump` package source:

```
https://www.okx.com/cdn/okex/traderecords/{data_type}/daily/{YYYYMMDD}/{SYMBOL}-{data_type}-{YYYY-MM-DD}.zip
```

| Data type | Status |
|---|---|
| `trades` | **HTTP 200, verified.** `BTC-USDT-SWAP` 2026-07-24 = 12.2 MB, 2026-07-20 = 16.3 MB. Current. |
| `aggtrades` | 404 at this pattern for `BTC-USDT-SWAP` — naming or scope differs; needs digging |
| `swaprate` (funding) | 404 at this pattern — same |
| L2 orderbook | not on this CDN; the local `5000lv` file came from some other OKX distribution |

`okx-dump` documents the schemas it expects:

- **trades / aggtrades** — `trade_id, side, size, price, created_time` (ms), `timestamp`
- **swaprate** — `contract_type, funding_rate, real_funding_rate, funding_time` (ms), `timestamp`
- **klines** — derived locally from aggtrades, not downloaded

It covers spot, swap and futures, defaults to `2021-10-01`, and pulls its symbol lists from
`api.tardis.dev` rather than OKX itself — worth noting as a dependency if that tool is used.

**If `swaprate` can be reached, OKX funding rate history is downloadable** and does not need
the WS `funding-rate` channel. Mark price and open interest have no bulk equivalent listed,
so those stay WS candidates.

### WS — verified

All channels below accept a subscription and deliver data on `BTC-USDT-SWAP`.

```json
trades         {"instId":"BTC-USDT-SWAP","tradeId":"2805987683","px":"64472.1","sz":"0.02",
                "side":"buy","ts":"1785060302444","count":"1","source":"0","seqId":331550485845}
tickers        {"instType":"SWAP","instId":…,"last":…,"lastSz":…,"askPx":…,"askSz":…,"bidPx":…,"bidSz":…,
                "open24h":…,"high24h":…,"low24h":…,"sodUtc0":…,"sodUtc8":…,"volCcy24h":…,"vol24h":…,"ts":…}
mark-price     {"instId":…,"instType":"SWAP","markPx":"64472.0","ts":"1785060301846"}
open-interest  {"instId":…,"oi":"3185878.69","oiCcy":"31858.79","oiUsd":"2054002894.90","ts":…}
funding-rate   {"fundingRate":"0.0000385651416411","fundingTime":…,"nextFundingRate":"","nextFundingTime":…,
                "premium":"-0.0005751117670039","interestRate":"0.0001","impactValue":"20000",
                "maxFundingRate":"0.00375","minFundingRate":"-0.00375","method":"current_period",
                "formulaType":"withRate","settFundingRate":…,"settState":…,"prevFundingTime":…}
bbo-tbt        {"asks":[["64472.1","820.89","0","36"]],"bids":[["64472","262.68","0","30"]],
                "ts":…,"seqId":331550485288}
instruments    accepted with instType=SWAP (snapshot; reference data)
```

Notes:

- OKX splits instrument-class data across four channels where Bybit has one. `funding-rate`
  is unusually detailed — premium, interest rate, impact value, the formula in use, and the
  funding rate bounds.
- `bbo-tbt` is tick-by-tick top of book, with order counts — the priority-3 candidate.
- No unfiltered subscription exists: `instId:"ANY"`, `instType` without `instId`, and a
  `trades-all` channel are all rejected `60018`. One subscription per instrument.

### Rate limits (from OKX docs, not measured)

- **3 connection requests/second per IP**
- **480 subscribe/unsubscribe/login per connection per hour**
- Their guidance for many 50/400-depth book channels: spread across connections, **under
  30 channels each** — further confirmation that per-symbol subscription is the expected
  shape.

Hoarder's exposure: reconnect resubscribes the whole tracked set in one batched frame
(1 request), but **startup sends one frame per channel**, so N channels costs N requests per
process start. Reconnect backoff starts at 200 ms, which can put ~3 connection attempts
inside the first second — right at the limit.

---

## Binance

### Bulk — `data.binance.vision` (verified by S3 enumeration + download)

```
https://data.binance.vision/data/{market}/daily/{type}/{SYMBOL}/{SYMBOL}-{type}-{date}.zip
```

| Market | Types published |
|---|---|
| `spot` | `aggTrades`, `klines`, `trades` |
| `futures/um` (USDⓈ-M) | `aggTrades`, `bookDepth`, `bookTicker`, `indexPriceKlines`, `klines`, `markPriceKlines`, `metrics`, `premiumIndexKlines`, `trades` |
| `futures/cm` (COIN-M) | same as `um`, plus `liquidationSnapshot` |

**Spot publishes no book data at all.** Everything book- and instrument-shaped is futures-only.

Samples pulled for `BTCUSDT` 2026-07-24:

```
bookDepth       timestamp,percentage,depth,notional
                2026-07-24 00:00:01,-5.00,9279.27600000,594684548.58150000
metrics         create_time,symbol,sum_open_interest,sum_open_interest_value,
                count_toptrader_long_short_ratio,sum_toptrader_long_short_ratio,
                count_long_short_ratio,sum_taker_long_short_vol_ratio
                2026-07-24 00:00:00,BTCUSDT,104507.163,6792955144.28,1.68852207,…
markPriceKlines open_time,open,high,low,close,volume,close_time,quote_volume,count,…
                1784851200000,65069.66,65084.00,65065.32710145,…   (1-minute)
```

Notes on what these are and are **not**:

- **`bookDepth` is not an order book.** It is depth-at-percentage-bands (±1…±5 % of mid)
  sampled once per second — notional resting within each band. Useful as a liquidity
  measure, useless for reconstructing a book. Real book history is absent.
- **`metrics`** is 5-minute open interest plus long/short ratios — genuinely
  instrument-class, and downloadable.
- **`markPriceKlines` / `premiumIndexKlines` / `indexPriceKlines`** give mark, premium and
  index at 1-minute OHLC. Instrument-class, downloadable, but binned — not tick-level.
- `bookTicker` is listed in the S3 prefix but returned 404 for this symbol/date; naming or
  coverage differs, needs another look.

### WS — verified (spot)

```json
aggTrade    {"e":"aggTrade","E":…,"s":"BTCUSDT","a":4022483483,"p":"64511.89","q":"0.00288",
             "f":6534153222,"l":6534153222,"T":…,"m":false,"M":true}
trade       {"e":"trade","E":…,"s":"BTCUSDT","t":6534153222,"p":"64511.89","q":"0.00288","T":…,"m":false,"M":true}
bookTicker  {"u":97856816298,"s":"BTCUSDT","b":"64511.88","B":"0.47198","a":"64511.89","A":"8.11666"}
```

`m` (buyer is maker) gives side. `trade` carries individual trade ids; `aggTrade` collapses
same-price fills and reports the id range (`f`..`l`).

`btcusdt@markPrice` was subscribed and produced **zero frames** in 25 s while trade and
bookTicker streamed on the same socket — confirming mark price is futures-only.

### Futures WS endpoint: `wss://fstream.binance.com/public/ws`

Verified working — 68 frames in 20 s, `depthUpdate` with `U`/`u`/`pu`.

Path matters, and wrongly-chosen paths fail *silently*:

| Path | Result |
|---|---|
| `/public/ws` + SUBSCRIBE frame | **works** |
| `/ws` + SUBSCRIBE frame | connects, **acks the subscribe**, never sends data |
| `/stream?streams=…` | connects, never sends data |
| `/ws/btcusdt@aggTrade` | connects, never sends data |
| `/public/stream?streams=…` | connects, never sends data |

The `/ws` row is the dangerous one: the socket opens, the SUBSCRIBE is answered
`{"result":null,"id":1}`, and no market data ever arrives. Same failure mode as an invalid
channel name — Binance acknowledges requests it will not honour, so **neither a successful
connection nor a successful ack is evidence that data will flow**. Only counting frames
proves a subscription works.

### All-symbol streams (verified)

Binance is the only venue with any unfiltered stream, and only for summary channels:

| Stream | Result |
|---|---|
| `!miniTicker@arr` | works — arrays of `24hrMiniTicker` across every symbol |
| `!ticker@arr` | acked, **zero frames** in 12 s |
| `!bookTicker` | acked, **zero frames** in 12 s |

There is no all-symbol `aggTrade` or `depth`. Confirmed the socket was healthy by running
`btcusdt@aggTrade` alongside — it streamed while those two stayed silent.

**Binance acks a subscription it will never honour.** `btcusdt@nonsense` is answered
`{"result":null,"id":…}`, identically to a real stream, so a typo produces silence rather
than an error, and an ack is not evidence a stream exists. The other three venues all
reject unknown channels explicitly.

### Conclusion

- **trade** — archive covers spot and futures back years; WS adds nothing but latency.
- **book** — **no book history exists** (`bookDepth` is percentage bands, not levels), and
  the WS depth stream is a *diff* stream that cannot be used alone. See below.
- **instrument** — futures only, and largely downloadable (`metrics`, `markPriceKlines`,
  `premiumIndexKlines`). Tick-level mark price would still need WS, which is blocked here.

---

### Binance books need REST, not just a subscription

`@depth` streams **diffs**, not snapshots, so a usable book requires the documented
snapshot-plus-diff procedure:

1. Subscribe to `btcusdt@depth` and **buffer** the events.
2. Fetch `https://fapi.binance.com/fapi/v1/depth?symbol=BTCUSDT&limit=1000` → `lastUpdateId`.
3. Discard buffered events where `u < lastUpdateId`.
4. The first event applied must satisfy `U <= lastUpdateId AND u >= lastUpdateId`.
5. Thereafter every event's `pu` must equal the previous event's `u`. **If it does not,
   start over from the snapshot.**

Quantities in each event are **absolute** for that price level, not deltas; zero removes the
level, and being told to remove a level you do not hold is normal.

**Implication for hoarder:** subscribing to `@depth` and archiving the frames is not enough
to reconstruct a book later. The archive needs periodic REST snapshots interleaved with the
diffs, and the `U`/`u`/`pu` values preserved so a reader can verify continuity and detect
where a resync was required. Hoarder currently has **no REST capability at all** — this is
the first WS channel that needs one, and it applies to every venue whose book is a diff
stream, not just Binance.

## Existing downloader tools

- **`bybit-history`** (PyPI, `suenot/bybit-history`) — a thin downloader for
  `public.bybit.com`: date range, coin filter, data-type filter, gunzips into a directory
  tree. Confirms the archive layout above; adds no data of its own.
- **`okx-dump`** (PyPI) — downloads OKX `trades`/`aggtrades`/`swaprate`, derives klines
  locally, writes Parquet. Its source is where the CDN URL pattern above came from.

Both are references for *what exists and where*, not dependencies — collection belongs in
our own services.

## The credentials question

Hoarder was built with **no credential handling of any kind** — public market data only, on
the reasoning that private streams need one pipeline per account and belong to a separate
service. Kraken's `level3` breaks that assumption: it is *public market data* that happens
to require an API token.

**Decided: skip L3.** Kraken's public `book` (L2) is collected instead. Hoarder keeps its
no-credentials design; the order-level detail is given up.

## State of play

### What is built

`services/hoarder` — a copy of `broadcast` reworked for multiple venues. Builds clean, 88
tests, BitMEX collection equivalent to what production runs today (same 8 channels, same 4
sockets, two of them for the `orderBookL2` pools).

- Venue-agnostic core: connection pool, subscriber, verbatim relay. One file per venue
  behind a `Venue` interface; adding a venue never touches the core.
- Five venues implemented and **verified live**: every channel in `channels.ts` acks and
  streams — bitmex 8/8, binance 4/4, okx 4/4, bybit 4/4, kraken 4/4.
- Publishes to its own `hoarder` AMQP exchange, routing key = venue name, envelope
  `x-venue` / `x-hoarder-uuid` / `x-collected-at`.
- Public data only, no credentials. Live endpoints only (no testnet). No command API —
  channels are fixed in `venues/channels.ts` and change by rebuild.
- Not wired into any module. Nothing consumes its exchange yet.

### What is known wrong

1. **`venues/channels.ts` predates this analysis.** It lists trades *and* books for BTC/ETH
   on the four new venues. This document now says trade feeds are largely redundant with
   bulk/REST, and that books are the thing worth streaming. The lists have not been
   rewritten because the remaining unknowns (below) change what belongs in them.
2. **Book channels are subscribed but not usable.** Binance `@depth` is a diff stream that
   needs interleaved REST snapshots and `U`/`u`/`pu` continuity checks to reconstruct
   anything. Bybit and OKX books carry sequence numbers and are probably the same. Hoarder
   has **no REST capability**, so what it would archive today is unreplayable.
3. **Symbol coverage is a placeholder.** BTC and ETH only. Per-symbol subscription is
   mandatory on every venue (only Binance has any all-symbol stream, and only for summary
   channels), so real coverage is a linear cost in subscriptions and connections that has
   not been sized.

### Conclusions that are settled

- **Trade data does not need WebSocket** on Kraken (REST has every field back to 2013),
  Bybit (archive is finer-grained than the feed), OKX (daily CDN, current) or Binance
  (Vision covers spot and futures). Pending only the Bybit `seq` question.
- **Book data needs WebSocket everywhere except OKX**, which publishes 1-second/5000-level
  files — and even there, WS is the only source of intra-second evolution. Bybit publishes
  no book history at all; Binance's `bookDepth` is percentage bands, not levels; Kraken has
  none.
- **Instrument-class data is mostly downloadable on Binance** (`metrics`, mark/premium/index
  klines) and **not at all on Bybit** (`tickers` is WS-only; the archive series died in
  2020). OKX depends on whether `swaprate` can be reached.
- **Kraken L3 is skipped** — authenticated, and hoarder stays credential-free.

## Next steps

In order, because each answer narrows the next:

1. **Finish the source survey.** REST for all four venues; OKX `aggtrades`/`swaprate`; the
   OKX L2 archive's real home; Bybit REST funding/OI history. Until these land, the channel
   lists cannot be written honestly.
2. **Settle the book-collection design.** Snapshot-plus-diff needs a REST client, a
   snapshot cadence, and snapshot frames distinguishable from diffs in the archive. Decide
   whether that lives in hoarder or in a service that does both.
3. **Rewrite `venues/channels.ts`** from the survey: drop redundant trade channels, keep
   books and instrument-class, and set real symbol coverage.
4. **Size the coverage.** Subscriptions per venue, sockets per venue, and OKX's limits
   (3 conn/s per IP; 480 subscribes per connection per hour; <30 book channels per socket).
5. **Build the consumer.** A journalist-equivalent for hoarder's exchange — new service,
   journalist untouched.
6. **Re-verify Binance futures from the deployment host** using `/public/ws`, since path
   choice fails silently.

## Open questions

1. **OKX / Binance bulk, and all four venues' REST** — not checked. Until they are, no WS
   channel for those venues can be justified or ruled out on trade or instrument data.
   Bybit's bulk is now mapped; its REST (funding history, open interest) is not.
2. **Kraken quarterly zips** — would close the 7-month recency gap in the bulk trades.
3. **Kraken intra-second ordering** — does bulk row order preserve execution order within a
   second? Testable against REST for a busy second.
4. **Instrument-class history** — is any of it downloadable or REST-queryable per venue?
   This decides whether funding/OI/mark must be captured live and therefore permanently.
5. **Which other venues' book feeds are diff streams** needing a REST snapshot companion?
   Bybit's `orderbook.*` and OKX's `books` both carry sequence numbers, so probably all of
   them — which makes REST snapshotting a general hoarder requirement, not a Binance quirk.
6. **Symbol scope** — per-symbol subscription is mandatory everywhere except Binance's
   summary streams, so coverage cost is linear in instruments and shapes connection count.
7. **OKX `aggtrades` / `swaprate` 404s** — both are documented by `okx-dump` but return 404
   at the pattern that works for `trades`. If `swaprate` is reachable, OKX funding history
   is downloadable and the WS channel is redundant.
8. **Where does OKX's 5000-level L2 archive live?** Not on the traderecords CDN. That is the
   only downloadable book history found so far, so its source matters.
9. **Does `seq` matter?** It is the one meaningful field Bybit's WS trade feed has that its
   archive lacks. If sequence numbers are not needed, Bybit WS trade can be dropped.
10. **`kline_for_metatrader4`** — not inspected; probably derived OHLCV, so likely redundant
   with bins built from trades, but cheap to confirm.
