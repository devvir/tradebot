# OKX

What okx's published archives actually contain, established by asking okx rather than by reading
its documentation.

## The archive has an index, and it is public

OKX publishes no bucket listing, so its URLs are constructed from a date and probed. That is
avoidable: the download portal's own form calls a list endpoint that needs no cookies and no
token.

```
POST https://www.okx.com/priapi/v5/broker/public/trade-data/download-link?t=<epoch-ms>
content-type: application/json

{"module":"1","instType":"SPOT",
 "instQueryParam":{"instIdList":["BTC-USDT"]},
 "dateQuery":{"dateAggrType":"daily","begin":"1751328000000","end":"1751414399999"}}
```

`begin` and `end` are epoch milliseconds. The reply carries one group per instrument, and inside
it one entry per published file — **filename, URL and size in MB**:

```
BTC-USDT-trades-2025-07-01.zip   3.57 MB
  https://static.okx.com/cdn/okex/traderecords/trades/daily/20250701/BTC-USDT-trades-2025-07-01.zip?v=999
BTC-USDT-trades-2025-07-02.zip   3.8 MB
```

`totalSizeMB` sums the selection. The `?v=999` suffix is part of what the portal hands out.

Two things this is worth beyond enumeration:

- **Sizes are an integrity check.** Binance is otherwise the only venue here that publishes
  anything to verify a download against, and it does it with `.CHECKSUM` files.
- **It answers absence directly.** OKX is the one venue whose 404s have been caught lying — the
  same URL returning 404 and then 200 seconds later — which is why its absences are probed twice
  and ledgered for spaced re-checks. A listing that says what exists removes the guess rather
  than making it more carefully.

The endpoint rate-limits: a handful of rapid calls returns `{"msg":"Too Many Requests",
"code":"50011"}`, so it needs the same pacing as any other okx call.

## What the parameters select

| `module` | series |
|---|---|
| `1` | trades |
| `2` | candlesticks |
| `3` | funding rates — **`SWAP` only**; asking for `SPOT` is what `50016` means |
| `4` | L2 order book, 400 levels |
| `5` | borrowing rates — takes `instQueryParam.ccyList` with `instType: SPOT` |

`instType` takes `SPOT` and `SWAP`, and they behave differently in a way worth knowing: **`SWAP`
answers with one venue-wide file per day** — `allswap-trades-2025-07-02.zip`, 208 MB — ignoring
the `instIdList` it was given.

## The floors, measured rather than read off the portal

| | portal says | the index says |
|---|---|---|
| spot trades | September 2021 | **2021-09-01** — asked 25 Aug–5 Sep, nothing before the 1st |
| spot L2 books | March 2023 | **2023-12-18** for `BTC-USDT` — nothing in Feb/Mar, Jun, Oct or late Nov 2023 |

So the trades floor is confirmed and the book floor is **not**: the portal's "March 2023"
describes the archive as a whole, presumably its earliest instrument, not this one. The adapter
keeps `20230301`, because a floor that is too early costs probes while one that is too late loses
data for whichever symbol did start then.

Books also have real holes — 2023-12-24 is absent between the 23rd and the 25th, on disk and in
the index alike.

**Whether the book window rolls is not established.** 2023-12-18 sat ~2.6 years back when
measured, which one observation cannot distinguish from a fixed start — the same trap bitget's
floor set. Re-probing that date in a few weeks answers it: if it has moved, OKX book history is
perishable and worth collecting first.

Funding and borrowing are published venue-wide, one file a day for every instrument at once:
`allswap-fundingrates-2025-07-01.zip` under `traderecords/swaprates/`, and
`allmargin-borrowrates-…` under `borrowrates/`. The borrowing archive's oldest file on disk is
2021-12-14, against a `RATES_START` of 2021-12-01 — so its true floor is a fortnight later than
the constant, which costs probes rather than data.

## Not yet established

- Whether `dateAggrType` accepts anything but `daily`, and whether a monthly aggregation returns
  different files or the same ones grouped.
- Whether the endpoint reckons days in UTC. A window ending `2021-09-05T23:59:59.999Z` returned a
  2021-09-06 file, which suggests a venue-local zone.

## Layout

```
okx/trades/daily/<yyyymmdd>/<INSTID>-trades-<yyyy-mm-dd>.zip     tick history
```

Books sit on an entirely different host prefix — `static.okx.com/cdn/okx/match` — which no guess
at the `traderecords` layout reaches; it was found through the portal's download call.
