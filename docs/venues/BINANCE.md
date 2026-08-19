# Binance

What Binance's published archive actually contains, established by asking Binance rather than by
reading its documentation — except where the documentation says something that cannot be measured,
which is noted as such.

## Publication cadence

From [Binance Academy](https://www.binance.com/en/academy/articles/how-to-get-trading-data-via-the-binance-api):

> Daily files are updated and available **the day after** trading happens, while monthly files are
> compiled and released on the **first Monday of each month**.

Both halves matter for anything deciding when a period is safe to treat as final:

- A day is not published until the following day, so "today" is never available and yesterday may
  not be either, depending on the hour.
- A month is not published on the 1st but on the **first Monday**, which can be as late as the 7th.
  Anything expecting a month to appear at the month boundary will find a gap of up to a week and may
  read it as missing data rather than as data not yet published.

Neither is verified here; both are Binance's own claim.

## Two renderings of the same period

Most datasets are published **both** as monthly files and as that month's days, for the same
history. They are the same trades in two shapes, so taking both stores everything twice.

The distinction is a path segment — `data/spot/monthly/…` against `data/spot/daily/…` — which is
what the prospector's `tagOf` reads. Where a consumer draws the line between them is its own
policy; the catalog records both and takes no view.

Not every dataset has both: `metrics` and `bookDepth` publish days only.

## Files carry checksums, and half of every listing is one

Every `.zip` has a `.zip.CHECKSUM` beside it, SHA-256. Consequences:

- A listing page of 1000 keys is only ~500 files. Anything reasoning about page counts against file
  counts must halve one of them.
- The sidecars are never catalogued: `.CHECKSUM` is excluded at every venue, before any venue's
  `inspectUrl` sees the path.

## Binance announces its own corrections

The [binance-public-data](https://github.com/binance/binance-public-data/) repository keeps an
**Updates** section:

> Archived files may be updated at a later date as a result of recently discovered issues.

Corrections are dated and packaged — a 2022-08-08 "fixed inconsistent data", a 2022-04-21
realignment to a change in spot aggregate trades — with the affected files published under an
`/updates` folder as, for example, `2022-08-08_kline_updates.zip`, each with its checksums.

**This is the only venue here that tells us which already-published files changed.** It is the cheap
answer to the one case a marker-based refresh structurally cannot see: an in-place change, where the
key stays and the bytes move. Worth using when in-place changes start mattering — treated as a hint
rather than truth, like every venue-published index we have examined, and kept behind a generic
"does this venue announce changes" seam rather than a branch in shared code.

## Layout

```
data/spot/{daily,monthly}/{aggTrades,klines,trades}/<SYMBOL>/[<INTERVAL>/]<SYMBOL>-…-<date>.zip
data/futures/{um,cm}/{daily,monthly}/<dataset>/<SYMBOL>/[<INTERVAL>/]…
data/option/daily/{BVOLIndex,EOHSummary}/<SYMBOL>/…
```

### `um` and `cm` are one market and two archives

**UM is USDⓈ-margined futures, CM is coin-margined** — binance's own words — and they are two
products, not two folders for one. UM answers at `fapi`, CM at `dapi`, and **every contract is
domiciled in exactly one of them**. The archive mirrors that split: `data/futures/um/` and
`data/futures/cm/`.

The catalog collapses both into the canonical market `perp`, which is right for answering questions:
both are perpetual swaps, and a consumer asking for `perp` wants both. It is wrong for *creating*
series, because the two are separate keyspaces — a contract listed by `fapi` can never have a key
under `cm/`.

So the instruments hook records **which endpoint listed a contract** as its `category`, the adapter's
`categoryOf` reads the margin segment back out of a pattern, and the preamble refuses the pairs that
disagree. Nothing is inferred from the symbol, and the reason is measured rather than stylistic:

- **`marginAsset` does not separate them.** `ETHBTC` is a UM contract margined in BTC, a coin — so
  "margined in a coin ⇒ CM" misclassifies it.
- **Nor does the ticker.** CM symbols are USD-quoted (`BTCUSD_PERP`, `LTCUSD`), but 43 UM symbols end
  in `USD` too, because BUSD does — `BTCBUSD`, `FTMBUSD`, `MATICBUSD`.
- **The endpoint is exact and free.** It is binance's own assignment, known at the moment the
  contract is read.

Binance is [integrating CM into UM's architecture](https://developers.binance.com/en/docs/products/derivatives-trading-coin-futures/Important-CM-UM-Integration-Notice)
— progressive from 2026-06-24, fully effective 2026-06-30 — sharing rate limits, merging market-data
streams, and letting some endpoints accept both symbol types. The `exchangeInfo` endpoints stay
separate and each contract keeps one domicile, but it is another reason not to pin this to a naming
convention: conventions under active unification are exactly what breaks quietly.

Left unfiltered this cost real work. The one perp listed on 2026-08-31 got **260 series — 130 of them
under `cm/`**, describing keys that market has never held; each is a `404` a day for ever, since a
series that has never published has no end to reach and nothing retires it.

CM is also small and closed: 30 contracts over 20 base assets, all `underlyingType: COIN`. UM is 883
and growing, spanning `COIN, EQUITY, CN_EQUITY, HK_EQUITY, KR_EQUITY, COMMODITY, INDEX, PREMARKET`
with a `TRADIFI_PERPETUAL` contract type — equity and commodity perps live there.

**Surveyed from the bucket root, and nothing is stripped.** Starting at `data/` would make
`data3/liquidationSnapshot/` permanently invisible, and descent recovers nothing above where it is
told to begin. Paths therefore keep their leading segment and stay self-describing, reconstructing
as `base` + `/` + `path` — which a stripped multi-root scheme could not do, since it would not know
which root to put back.

The archive is addressed two ways: listings from the S3 endpoint
(`s3-ap-northeast-1.amazonaws.com/data.binance.vision`), files from CloudFront
(`data.binance.vision`).

What the adapter refuses, since surveying the root also reaches things that are not archive:

```
data2/…                 staging
data3/<file>            a stray key directly under data3; only its subdirectories hold data
```

The browsing UI's own assets need no rule — `index.html` and friends carry no date, so they are
declined for the same reason checksums are.

Dates trail the filename — `…-2025-03-31.zip` for a day, `…-2025-03.zip` for a month — so keys sort
by symbol first and date last, and a month's files are scattered across a walk rather than
contiguous.

### Prefixes outside `data/` — one of them holds data that exists nowhere else

The bucket root holds more than `data/`: `data2/`, `data3/`, a `/`-prefixed variant, and the web
assets serving the browsing UI (`index.html`, `bootstrap.min.css`, …).

The distinction that matters is **offered against merely reachable**. `data/` is what binance's own
site presents, and carries whatever assurance an announced service implies. Everything beside it is
publicly reachable and promised to nobody — it may be removed, rewritten or left inconsistent
without notice. That is not a reason to ignore it; it is a reason to take it *sooner*, since nothing
says it will be there next month.

**`data3/liquidationSnapshot/` is real, and unique.** 311 symbols, hundreds of daily files each with
`.CHECKSUM` sidecars, back to mid-2023 — order 60k files. The symbols are USDT-margined, and the
measurement that settles it:

| | |
|---|---|
| `data/futures/um/daily/liquidationSnapshot/` | **0 symbol directories — does not exist** |
| `data/futures/cm/daily/liquidationSnapshot/` | exists, coin-margined only |
| `data3/liquidationSnapshot/1000FLOKIUSDT/` | exists; the same symbol is absent from `data/` |

So the USDT-margined liquidation snapshots live *only* in `data3/`. This also corrects an earlier
note that "liquidationSnapshot exists only under `cm`" — true of `data/`, false of the bucket.

**`data2/` is a staging area** and can be ignored: uncompressed `.csv` files sitting beside their
own `.zip` for the same period, a `.DS_Store`, everything dated 2020-10 to 2020-12.

```
data2/data/spot/klines/1INCHUSDT/12h/1INCHUSDT-12h-2020-12.csv
data2/data/spot/klines/1INCHUSDT/12h/1INCHUSDT-12h-2020-12.zip
data2/data/spot/trades/.DS_Store
```

The lesson generalises past binance: **descent guarantees nothing above where it is told to
start**, so a hardcoded root reintroduces one level up precisely the omission descent exists to
prevent. Binance now surveys from the bucket root and filters, which is why `data3/` is visible at
all. HTX was checked the same way and was hiding a second archive six years deep, so it surveys from
its root too. KuCoin was checked and is clean — its bucket root holds `data/` and nothing else.

### The `/`-prefixed tree — a frozen snapshot, refused

**There are no directories in S3.** Keys are flat strings and `/` is a convention that
`delimiter=/` renders as folders, so a key whose first character is a slash is perfectly legal. All
of them group under a `CommonPrefix` of exactly `/`, which is why the bucket root appears to serve
one alongside `data/`, `data2/` and `data3/`. It is not a folder; it is the shadow of keys that begin
with a slash — most likely a path-join bug in whatever uploaded them.

What is under it, measured:

```
/data/spot/{aggTrades,klines}/<SYMBOL>/[<INTERVAL>/]…-<yyyy-mm>.zip
137,212 files      2017-07 → 2021-01, then nothing
```

Both trees fetch with `200`. The reconstructed URL keeps the double slash —
`data.binance.vision//data/spot/…` — and resolves, because the key genuinely starts with one.

#### Every filename is duplicated, and so is every value inside

Compared across the whole tree, mapping `/data/spot/X` to `data/spot/monthly/X`:

| | |
|---|---|
| files under `/data/spot/` | 137,212 |
| with a same-named counterpart under `data/spot/monthly/` | **137,212 — all of them** |
| with the same `etag` | **0** |

Different bytes throughout, which for a long time was where the question stopped: a different
`etag` at the same `size` is consistent with recompression, a different size is not, and nobody had
opened a file from either tree.

**Opened, they turn out to hold the same data.** The bytes differ for two reasons, neither of them
new information.

**Decimal padding.** Every value matches; only the rendering moved. Binance re-issued the archive in
2021-05 — visible in the zips' own internal timestamps, 2021-01-16/17 against 2021-05-05 — and
trimmed the trailing zeros:

```
/data/spot/…   0,0.14000000,74.30000000,0,0,1553659205228,False,True
data/spot/…    0,0.14,74.3,0,0,1553659205228,False,True
```

Three `aggTrades` pairs compared in full: same row counts, and **byte-identical once the padding is
normalised**.

**Truncation, where the freeze caught a month in flight.** `1INCHBTC-1d-2021-01` holds 12 rows here
against the official 31, ending 2021-01-12 rather than 2021-01-31 — and its last row is a *partial*
candle, same open, lower high, a third of the volume, 4,383 trades against 11,192.

So the tree is a **snapshot of the spot archive frozen around 2021-01-12**. It carries no file the
official tree lacks and no value it lacks either; where the two disagree it holds strictly less.

**It is refused, in `accepts`.** A key beginning with `/` is not surveyed, so nothing re-adds it, and
the 137,212 rows an earlier walk recorded were deleted along with their 16 patterns and 11,239
series. This is the rare exclusion of something that *is* historical data — earned not by the
`etag` comparison, which says only that the bytes differ, but by reading both renderings and finding
one to be the other with less of it.

## Discovery

A standard S3 listing: `prefix`, `marker` and `delimiter` all honoured. `max-keys` caps at **1000** —
larger values are echoed back in `<MaxKeys>` and never applied, so a response looks like it worked.
`NextMarker` is returned only when a `delimiter` is sent; without one, pagination continues from the
last key of the page.

Ten `delimiter=/` requests map the whole archive, and doing it that way rather than listing datasets
in code is what surfaced `option/`, `BVOLIndex`, `EOHSummary` and `aggTrades` — none of which were
being collected.

## Rate limits

**None documented, and none signalled in responses.** No `x-ratelimit-*`, no `retry-after`, and
notably no `x-mbx-used-weight` — that header and the documented 429 → 418 ban ladder belong to
`api.binance.com`, which is a different service with its own weight accounting. The archive is an
anonymous public S3 bucket fronted by CloudFront.

The [binance-public-data](https://github.com/binance/binance-public-data/) repo documents no limits,
throttling policy or concurrency guidance either. The one relevant community report
([Download limits for data.binance.vision](https://dev.binance.vision/t/download-limits-for-https-data-binance-vision-data-spot/20275))
has a user hitting `SSLEOFError` on bulk downloads which support attributed to rate limiting, but no
Binance staff ever stated a threshold — and that was the CloudFront download host, not the S3
listing endpoint.

For reference, S3's own published ceiling is 5,500 GET/HEAD per second per partitioned prefix, which
nothing here approaches. Measured: a single listing takes ~1.0 s, and eight concurrent listings
complete in 2.1 s against 14.4 s sequential — 6.8× with no degradation and no throttling signal.

The absence of a documented limit is not proof of no limit. The mitigation is that transport errors
and 5xx/429 are retried with jittered exponential backoff, so throttling degrades into slowness
rather than lost data.

## Scale

Order 10⁸ keys across the whole bucket, of which about half are checksum sidecars. At 1000 keys a
listing page, that is order 10⁵ pages to walk the bucket whole — which is why it is catalogued by
prefix walks rather than by asking each of ~3,700 symbols what it holds for each month.

## Its raw cannot be reclaimed yet

Binance was downloaded **symbol-first rather than month-first**, so it holds symbols complete from
their start through 2026-07 and **no closed months at all**. Month-completeness is the unit cold
storage works in, so none of it is packable and none of it is evictable.

The files are the right files in the right paths — nothing about them is wrong and nothing about
them should be deleted. It becomes evictable as the month-first flow closes those months one at a
time.
