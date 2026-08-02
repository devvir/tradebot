# Bitget

What bitget's published archives actually contain, established from the files on disk. Facts
here are measured, not read off documentation.

## Trade timestamps carry only second resolution

The `timestamp` column is epoch **milliseconds**, but the millisecond part is **always zero** —
every value ends in `000`.

Measured over 133,260 rows across 32 consecutive files of `SNXUSDT`: **zero** rows with a
non-zero millisecond part. Confirmed independently on a built partition: of ~9.6 M rows in
`BTCUSDT` 2024-06, `count(DISTINCT ts % 1000000)` is **1**.

So a bitget trade is stamped to the second, and on a liquid symbol hundreds of trades share one
stamp. Consequences:

- **`ts` cannot order trades within a second.** Sequence lives in `trade_id` and in file order.
  Anything reconstructing a tape — fill simulation, queue-position modelling, trade-by-trade
  replay — has to use one of those, and neither is a substitute for a real clock.
- **Sub-second bins are not derivable** from this source. Binance and bybit publish millisecond
  or finer stamps, so a bin size below a second is available there and not here.
- **This is a reason to look at REST or WebSocket for bitget**, if finer timing turns out to
  matter. Their live feeds may stamp more precisely than the daily archives do — worth checking
  payloads before assuming either way. Nothing to act on yet; recorded so the question is asked
  rather than rediscovered.

## Buckets cut at 16:00 UTC, not midnight

A file named `20250101` covers **2024-12-31 16:00 → 2025-01-01 16:00 UTC** — midnight in UTC+8.

Verified across 120 files sampled over all 514 spot symbols and the whole range on disk
(2024-04-18 → 2026-07-28): zero rows outside the shifted window, zero before it. The boundary is
exact — 21 of the 120 open at precisely `16:00:00.000`, and the rest are illiquid symbols whose
first trade comes later.

The timestamps themselves need no correction: they are correct UTC instants. Only *which file
holds a row* is shifted. Stocker handles it with the declarative `spill: 'back'` trait — it
reads one neighbouring bucket into each month and clips the output to the month — so partitions
are exact UTC months. See `docs/services/STOCKER.md`, "Venues whose buckets do not cut at UTC
midnight".

**Only spot trades have been verified.** Futures products and the kline/depth datasets are not
on disk yet. A bar's own timestamp is a separate question from its file's bucketing, so klines
deserve their own check when they land.

## Multi-part days are independent zips

A busy day is split as `20250117_001.zip`, `_002.zip`, and so on. These are **not** a spanned
archive: each opens and verifies standalone, has its own end-of-central-directory record, and
contains one CSV **with its own header row**. A true multi-part zip would use `.z01`/`.z02`
naming and refuse to open a part alone.

The split is sequential by size and the parts do not overlap — part 001 of `GPSUSDT 20250117`
ends at `1737109419000` and part 002 begins at `1737109421000`. Concatenating in name order
reproduces the day, and stocker's reader drops each part's header row as an unparseable
timestamp, so no special handling is needed.

## Sentinel value in depth

The depth dataset publishes a missing quote as **`-999999`**, not as an empty field. It has to
become NULL or every spread computed from this venue is wrong. Handled in the series map.

## The archive has an index, and it is public

Bitget's CDN answers `403 AccessDenied` to every directory or bucket-style query, so the archive
looks unenumerable. It is not. The download portal's own form calls a list endpoint that takes no
cookies, no token and no CSRF header:

```
POST https://www.bitget.com/v1/statistics/public/download/getPublicDataV2
content-type: application/json;charset=UTF-8

{"displaySymbol":["BTC/USDT"],"businessLine":1,"businessType":1,
 "dateType":1,"beginTimeStr":"2020-08-08","endTimeStr":"2020-08-14"}
```

It returns one row per published file — `dateTimeStr`, `fileName`, `fileUrl`.

| parameter | values |
|---|---|
| `businessLine` | `1` spot, `2` futures (both margin types at once). `3`+ → `40003` |
| `businessType` | `1` klines, `2` trades, `3` depth. `4`+ → `40003` |
| `dateType` | `1` daily |
| window | **7 days maximum** — a wider range fails `40003 Parameter verification failed` |

**The two catalogues spell symbols differently**, and asking with the wrong form returns an empty
list rather than an error — which reads exactly like "no data" and is why futures first looked
absent:

| | symbol form | example |
|---|---|---|
| spot (`businessLine 1`) | `BASE/QUOTE` | `BTC/USDT` |
| futures (`businessLine 2`) | plain | `BTCUSDT`, `BTCUSD` |

The futures line answers for USDT- and coin-margined together, and says which only in the key it
returns, so a reply has to be filtered by path before it is stored — otherwise coin-margined files
land in the USDT tree.

Sustained querying earns a `429`, so index calls need the same retry-with-backoff the listings use.

**One query may name five symbols**, and each row says which it belongs to, so the reply can be
split. That is the only lever on the request count — `dateType: 2` returns nothing, so the
seven-day window cannot be widened. It decides whether a backfill is practical: bitget's history
across ~1,900 symbols and three series is roughly **1.1 M requests one at a time, or 220 k in
fives**.

**The older naming does not reach depth**, because depth's archive does not reach back that far.
Asked for `BTC/USDT` depth, the index answers empty for 2020-08, 2022-01, 2023-06 and 2024-06, and
answers normally for 2025-06 — while klines over the same 2020-08 window return the old flat names.
So depth exists only under the nested form:

```
https://img.bitgetimg.com/online/depth/BTCUSDT/1/20250601.zip
```

Note the index's `fileName` is a **display** name (`BTC/USDT-20250601.zip`) and never reveals which
naming a file uses. Only `fileUrl` does, which is why reading `fileName` made the two shapes
invisible.

One thing it will not answer:

- Whether the early gaps are the venue's or the index's — `BTC/USDT` spot trades are absent on
  2018-07-26 and 2019-06-01.

Two properties make it an index rather than a URL generator: a window before a symbol existed
returns `[]`, and the launch day itself is excluded — `BTC/USDT` from 2018-07-24 starts at
**2018-07-25**, the day after ETHUSDT (16:40 UTC) and BTCUSDT (17:46 UTC) began trading. Bitget
does not publish the partial first day.

Rows arrive **duplicated**, four per file in every window sampled, so the response has to be
deduplicated by URL. Trades rows enumerate the `_001`, `_002` parts individually, so the part
count is read rather than discovered by probing for the first absent one.

## Two file-naming shapes, and both are live

The same series is published under two names, and they interleave inside a single week:

```
kline/BTCUSDT/BTCUSDT_SP_1min_20180725.zip           kline/BTCUSDT/SP/20250601.zip
trades/SPBL/BTCUSDT/BTCUSDT_SPBL_20180725_001.zip    trades/SPBL/BTCUSDT/20250601_001.zip
```

Both return 200. Nothing distinguishes which name a given date uses — 2020-08 alone mixes
`SP/20200814.zip` with `BTCUSDT_SP_1min_20200813.zip` — so **the naming cannot be constructed and
must be read from the index.**

This is what makes the archive look far shorter than it is. Probing the newer shape finds its
first date, 2024-04-18, and that date is the naming change, **not** the start of the archive:
spot klines and spot trades both run back to **2018-07-25**, verified by HEAD on the index's URLs.
Roughly six years of history sits behind the older name.

Availability is genuinely patchy in the early years and has to be read, not assumed. For
`BTC/USDT` spot trades: 2018-07-25 present, 2018-07-26 absent, 2019-06-01 absent, 2021-01-01
onward present.

## Symbols and their launch dates

`https://api.bitget.com/api/v3/market/instruments?category=SPOT` returns 1,209 live spot symbols,
**every one carrying a `launchTime`** — none empty, none zero. The earliest are ETHUSDT
(1532450400000, 2018-07-24 16:40 UTC) and BTCUSDT (1532454360000, 2018-07-24 17:46 UTC), which
matches bitget's 2018 founding.

The list covers live symbols only (1,208 `online`, 1 `limit_open`), so it bounds what survives,
not what ever existed — a pair listed and delisted before today would not appear.

The portal datepicker enables dates from 2018-01-02. That is a UI constant with nothing behind
it: no bitget spot pair existed until 2018-07-24.

**Futures start later than spot.** Bracketed on `BTCUSDT` klines: 2019-06-01 comes back empty and
2019-08-01 returns a file. The exact day between the two is not pinned down.

## `dmcbl-klines` is not a dead dataset — the path was wrong by one segment

Coin-margined klines are filed under the **`UMCBL`** token, not `DMCBL`:

```
kline/BTCUSD/UMCBL/20250601.zip     200
kline/BTCUSD/DMCBL/20250601.zip     403
```

That is why 55 of 55 probes across 11 symbols and 5 dates came back `403 AccessDenied` and the
series read as publishing nothing. It publishes normally; every probe missed by one path segment,
and the control that proved "the URL shape is right" was itself built on the wrong token.

Trades are unaffected — they use the real product type, `trades/DMCBL/BTCUSD/…`. So the token a
symbol is filed under depends on the *series*, not only on the market:

| series | token |
|---|---|
| spot trades | `SPBL` |
| spot klines | `SP` |
| futures trades | `UMCBL` / `DMCBL`, per margin type |
| futures klines | **`UMCBL` for both margin types** |
| depth | `1` spot, `2` futures |

## Layout

```
bitget/trades/SPBL/<SYMBOL>/<yyyymmdd>_<nnn>.zip     spot trades  (CSV in zip)
bitget/kline/<SYMBOL>/<SP|UMCBL|DMCBL>/…             klines       (XLSX in zip)
bitget/depth/<SYMBOL>/<1|2>/…                        best bid/ask (XLSX in zip)
```

The older names sit under **trades and kline only**, with the symbol and market folded into the
filename instead of the path — `kline/BTCUSDT/BTCUSDT_SP_1min_20200808.zip`. Depth has no older
form, its archive beginning long after the naming changed.

Stocker's matchers carry both shapes for klines, and trades never needed it: that pattern stops at
the symbol directory and does not constrain the filename, so it already caught both.

The container says nothing about the format: klines and depth are an **XLSX inside a `.zip`**,
so each series declares its format separately.

`dmcbl-klines` appears to publish nothing — 55 of 55 probes across 11 symbols and 5 dates
returned `403 AccessDenied`, against a control proving the URL shape is right. Worth confirming
against the portal before concluding the dataset is dead.
