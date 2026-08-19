# HTX

What htx's published archive actually contains — measured against the bucket, and checked against
what htx says about it. Two announcements cover the archive change and both are worth reading before
inferring anything:

- [The upgrade](https://www.htx.com/support/25034776369944/), live `2026-06-03` — a restructured
  directory layout, standardised field names across all datasets, order books and funding rates added,
  options discontinued.
- [The legacy shutdown](https://www.htx.com/support/55039723330936/) — updates to the old bucket
  discontinued `2026-08-04`, with what is already there retained and still downloadable.

Neither says anything about which instruments made the move, which is the part that had to be
measured. Where the two disagree, the bucket wins: the shutdown notice says legacy data "dated August
3, 2026, and earlier" is retained, while klines and trades are in fact present for `2026-08-04`.

## Two archives in one bucket: the current one and the one it replaced

HTX publishes **two trees**, and both are official — the data portal
([`/futures/data/landing_page/`](https://www.htx.com/futures/data/landing_page/), which carries a
Spot tab without changing the URL) links the first directly, and its **Visit Old Version** button
links the second.

| | `historical_data/` | `data/` |
|---|---|---|
| status | current, and the one the portal offers | the "old version", still linked |
| earliest | `2026-02-01` (books `2026-05-28`) | `2018-11-09` futures trades, `2020-06-01` BTC spot |
| latest | written daily, tip is yesterday | **`2026-08-04`, nothing written since** |
| symbols | dashed throughout, perps suffixed `-PERP` | varies by market — see below |
| markets | `spot`, `futures` | `spot`, `future`, `swap`, `linear-swap`, `option` |
| layout | `<market>/daily/<dataset>/<SYMBOL>/` | `<dataset>/<market>/daily/<SYMBOL>/` |

**The trees spell an instrument differently in three of the five cases**, which is what any
comparison between them has to get past first — there is no single transformation from one to the
other:

| market | `historical_data/` | `data/` |
|---|---|---|
| spot | `BTC-USDT` | `BTCUSDT` |
| perpetual | `BTC-USDT-PERP`, `BTC-USD-PERP` — the suffix belongs to the shape | `BTC-USDT`, `BTC-USD` |
| dated, coin-margined | `BTC-USD-260206` | `BTC260206` — no quote currency at all |
| dated, USDT-margined | `BTC-USDT-260206` | *the same* |
| option | — | `BTC-USDT-200828-C-10500` |

**The perpetual row resolves itself, because `-PERP` is a property of the keys rather than of the
instrument.** Every key of the offered tree's perpetual shapes carries it and none of its dated ones
do, so it belongs in the pattern — `futures/daily/trades/{SYMBOL}-PERP/{SYMBOL}-PERP-trades-…` —
and the contract is `BTC-USDT` in both trees, which is what `data/` has always called it. A URL is
rebuilt from the pattern, so nothing is lost by not storing the suffix.

**The other two rows are transformations inside the name**, which no pattern constant can express,
so the dashed form is stored as the symbol and `data/`'s own spelling beside it as `url_symbol` —
one contract, one name, and a URL still rebuilt from what the archive actually writes.

- **Spot** joins the pair, and separating it needs to know where the quote begins. That is a closed
  question rather than an open one: `data/` stopped on `2026-08-04`, so its 2,309 spot pairs are all
  it will ever hold, and **26 quote currencies cover every one of them** — matching the *longest*
  suffix, because `USDTRUB` is `USDT`/`RUB` and a rule that stopped at the first currency it
  recognised would read it as `USD` against a `TRUB` that does not exist. `EUROC` and `EUR` are the
  same trap, and `USD1` is a stablecoin rather than a typo.
- **Coin-margined dated** contracts name a base and an expiry alone, and settle against `USD`, so
  `ADA200807` becomes `ADA-USD-200807` without guessing.

Nothing consults the offered tree or the live listing to do this. A rule that did would re-spell a
finished archive whenever htx listed or delisted something.

Options are the remaining trap — a six-digit strike like `-C-100000` reads as an expiry to anything
testing for one — which is why the `option` market is never asked.

**The old tree has gone quiet; the migration has not finished.** Two different claims, and only the
first is observed. Every `data/` prefix was last written on 2026-08-04/05 and has not moved since,
while every `historical_data/` prefix is written daily. Read from the bucket's own `LastModified`,
not inferred from a missing file — a `404` on one day says only that one day is absent.

But 75 symbols that `data/` carried never appear in `historical_data/` at all. So this is not a venue
that moved its archive and closed the old one. It is a venue whose new tree took its instruments in
one go on `2026-02-01`, never took the rest, and left them to end where the old tree ends.

**The old tree's stop is announced and final**, so `2026-08-04` can be relied on. What is not settled
is the other direction: the new tree may still backfill what it skipped, which would change who
carries what during the overlap.

**Htx backfills, demonstrably.** The upgrade went live `2026-06-03`, yet funding data reaches back to
`2026-02-01` and books to `2026-05-28` — both populated backwards past their own announcement. A
floor here is where the data currently starts, not where it will always have started, so re-read a
prefix rather than trusting a floor written down months earlier.

**Neither tree is a rolling window.** `historical_data/` still holds its first day, `2026-02-01`,
unchanged nearly seven months on; a floor is a launch date here, as it is at every other venue. The
books floor of `2026-05-28` is a second, later launch rather than a shorter window.

### Where they ran together: `2026-02-01` to `2026-08-04`

**Both ends of the span are declared by HTX, not merely inferred.** The data portal states
*"Historical data from February 1, 2026 is supported. For older data, please visit the old version"*
beside its own **Visit Old Version** button, and the legacy shutdown notice gives the other end. The
bucket agrees with both.

**Where both trees carry a day they agree on its values, but they do not carry the same days.**
Measured over the whole overlap, `historical_data/` holds **10,608 instrument-days that `data/` does
not**, across 6,334 series. Only 4,096 of those sit past the old tree's own last day for that series
— the rest, **6,512 days across 2,302 series, are holes in the middle of a range `data/` was still
publishing**. They run from February to June 2026, peak across April and May, and stop entirely
after June; the old tree then ran clean until it stopped.

The holes are concentrated in `trades` and `klines` and they hit ordinary instruments, not obscure
ones — `DOGE-USDT` spot is missing 51 days, `SOL-USDT` 43, `OM-USDT` spot trades 19. They are the
venue's, not an artifact of how far anything has read: the walk that measured them left nothing
unresolved, and the new tree's files for those days carry real trades rather than empty placeholders
(`T-USDT` on `2026-03-01` holds 1,222 prints and on `2026-04-15` holds 16,480, where `data/`
publishes nothing at all).

**In the other direction there is almost nothing.** Across the whole window `data/` carries exactly
**63 series-days** that `historical_data/` lacks: `indexPrice`, all seven intervals, for the nine
coin-margined perpetuals, on the single day `2026-06-03` — the day the upgrade went live. That is
the only day in six months where the old tree is the sole source for something both trees otherwise
carry.

**Four datasets are carried by both** — `klines`, `trades`, `indexPrice` and `markPrice`. Every one of
them differs in shape between the trees, read off real files on `2026-08-03`:

| dataset | market | `historical_data/` | `data/` |
|---|---|---|---|
| klines | spot, perp | `instId,open,high,low,close,vol,volCcy,volCcyQuote,ts` | `timestamp,open,close,high,low,vol,amount` |
| trades | spot | `instId,tradeId,px,side,size,ts` | `Trade ID,Trade Time,Trade Price,Volume (Base Currency),Side (buy/sell)` |
| trades | perp | `instId,tradeId,px,side,size,ts` | `Trade ID,Trade Time,Trade Price,Volume (in Contracts),Volume (in Base Currency),Turnover,Side (buy/sell)` |
| index / mark | perp | `instId,open,high,low,close,ts` | `timestamp,open,close,high,low` |

**The new tree normalises where the old one does not.** New `trades` has one shape for spot and perp
alike, and new `indexPrice` and `markPrice` share a header; the old tree's `trades` varies by market,
carrying three extra columns on perps. Anything written against the old tree needs a shape per
market; against the new tree it needs one per dataset.

**Neither side is a superset.** Column order differs — OHLC against OCHL — and so does the set: new
klines carry `volCcyQuote`, the quote turnover, which the old tree has no column for, while old perp
trades carry base volume and turnover that the new tree drops. The volume names also invert, `data/`
calling the quote figure `vol` and the base one `amount` against `historical_data/`'s `vol` for base
and `volCcy` for quote. Joined on timestamp for `BTC-USDT` 1m, all 1,440 bars of a day match exactly.

**The old tree never adopted the new shape.** Its final files, `2026-08-04` klines and trades on both
spot and perp, carry exactly the schema above — the two trees ran side by side for six months without
converging, and the old one stopped writing in its own format rather than switching. So **branch
determines parser, with no date involved**: a key under `data/` is old-shape, a key under
`historical_data/` is new-shape, and since neither prefix is stripped, provenance is legible from the
key alone.

**The old tree's own schema did move over its six years**, which is a separate axis and sits entirely
before the overlap. Its earliest `indexPrice` files head with `id,open,close,high,low` where 2026
files say `timestamp`, and its earliest spot klines carry no header at all. There is no single "old
schema" to write a reader against — only one per era.

**`data/` carried no header row at all until between `2026-03-01` and `2026-04-01`**, when one
appeared; its columns did not change, and a 2021 row parses with the same seven fields as a 2026
one. Anything counting rows has to account for that or be off by one on the earlier files.

### What only exists in one of them

- **Only in `data/`: everything before `2026-02-01`.**
- **Only in `historical_data/`: order books and funding rates.** Not a gap in `data/` — HTX did not
  publish either dataset before the new tree, so there was never anything to migrate. Funding runs
  from the tree's own floor, `2026-02-01`; books start later, `2026-05-28`, on both `lv400` spot and
  `lv150` futures.

**The `option` market has nothing to do with the migration.** It lives only under `data/`, and its
last file of any kind is dated `2021-06-25` — options stopped in June 2021, five years before the
new tree opened, so all 954 option symbols fall entirely on the `data/` side of any cut and
constrain nothing.

**The new tree's `futures/` is three of the old markets merged**, told apart by the symbol rather
than by a directory: `…-USDT-PERP` is `linear-swap`, `…-USD-PERP` is `swap`, and `BTC-USD-260206` is
a dated `future`. So no market the new tree needed to carry is missing from it. HTX says as much
itself — the portal's Mark Price card offers the dataset "for perpetual and delivery futures", so
the tab is a grouping rather than a market in its own right.

**The portal's two tabs are the tree's two directories**, and what each offers says which datasets
belong to which kind of instrument:

| tab | datasets offered |
|---|---|
| Futures | Order Book (L2 150), Single Trade, Candlestick, Index Price Candlestick, Mark Price Candlestick, Funding Rate |
| Spot | Order Book (L2 400), Single Trade, Candlestick |

Index and funding are perpetual-only and mark covers both contract kinds, which is exactly how the
archive is laid out: `indexPrice` and `funding` appear under `perp` alone, `markPrice` under `perp`
and `future` both.

**`data/` does the same thing under `linear-swap/`, and only there.** A dated USDT-margined contract
sits in the same directory as the perpetual it settles against —
`data/klines/linear-swap/daily/BTC-USDT-230407/` beside `data/klines/linear-swap/daily/BTC-USDT/` —
so `linear-swap` is a settlement currency, not a contract kind, and only the symbol says which is
which. 616 dated symbols live there, across six roots (`BTC-USDT`, `ETH-USDT`, `DUSK-USDT`,
`CVX-USDT`, `DOSE-USDT`, `TOMO-USDT`). The old tree's own `future/` market, by contrast, is dated
throughout and coin-margined.

**Reading the instrument rather than the directory is what makes the two trees agree.**
`BTC-USDT-260206` is a `future` under `historical_data/futures/` and sits under
`data/…/linear-swap/` in the old one; 56 symbols are carried by both trees this way, and each has to
land in one market or the branches will not join on what they have in common. The old tree's dated
symbols carry the expiry, `BTC-USDT-230407`, where the new tree's perpetuals carry a `-PERP` suffix
— two spellings of the same question, and the adapter asks it of both.

### Addressed at the bucket, not at the CDN in front of it

`www.htx.com/data/` is the same bucket through Akamai, unchanged in content — the portal's download
buttons go through `/vision/?prefix=…`, a browser over the same keys. The edge enforces a limit far
below what S3 serves: half a dozen listing requests earn a `403 AkamaiGHost` on every prefix at
once, and probes that are neither answered nor refused, sockets left silent until each dies on its
own deadline. The bucket names itself in every listing (`<Name>huobi-service-data</Name>`) and is
public, so it is addressed directly.

That also restores readable semantics: through the edge a `403` with no `x-amz-error-code` is
indistinguishable from a real block, so absence and rejection arrive as the same answer. Against S3
a missing key is a plain `404`.

HTX is surveyed **from the bucket root**, with `assets/` and `test/` refused, because descent
guarantees nothing above where it starts: a root of `historical_data/` keeps the sibling tree out of
the search entirely. That is the general rule — a hardcoded root reintroduces one level up precisely
the omission that discovering prefixes exists to prevent — and it applies identically to binance's
`data3/liquidationSnapshot/`.

**`remark.txt` sits at the root of each `data/` dataset+market** — thirteen of them, holding the
field descriptions that the new portal shows in a dialog instead. They are documentation rather than
data.

## Daily files are UTC+8 days, not UTC days

A file named `<yyyy-mm-dd>` holds `16:00:00` UTC the previous day through `15:59:5x` UTC that day —
a Beijing day, cut at midnight UTC+8. Read off real trade timestamps in `BTC-USDT` spot, `BTCUSDT`
spot and `BTC-USDT-PERP`, and identical in **both trees**, so the shift is a property of the venue
rather than of either archive.

The REST API agrees: its `1day` kline `id` is the same UTC+8 day start, which is why a bar rendered
with a UTC formatter appears to sit one day before the file covering the same trades. They match
exactly once both are read as UTC+8.

This is the same trait as bitget's `16:00` UTC cut, so it belongs in the declarative `spill` handling
rather than anywhere venue-specific. The date parsed out of a path is a **UTC+8 day label**, and
anything that treats it as a UTC day misplaces eight hours of every file.

## Books are the richest published anywhere bar OKX

400 levels on spot, 150 on futures, shipped as `.tar.gz` rather than the `.zip` everything else
uses. Records carry the same `instId`/`action`/`ts` shape as OKX's, which is why the two venues'
portals look alike.

## Layout

```
historical_data/<market>/daily/<dataset>/<SYMBOL>/<SYMBOL>-<stem>-<yyyy-mm-dd>.zip
historical_data/<market>/daily/orderbook/lv{400,150}/<SYMBOL>/…tar.gz

data/<dataset>/<market>/daily/<SYMBOL>/<SYMBOL>-<stem>-<yyyy-mm-dd>.zip
data/klines/<market>/daily/<SYMBOL>/<interval>/…
```

Note the two trees **invert dataset and market**: `historical_data/spot/daily/trades/` against
`data/trades/spot/daily/`. Nothing is stripped from either, so a stored path says which tree it came
from and reconstructs as `base` + `/` + `path`.

Only a daily shape exists in both — no monthly files — so the granularity cutover never applies
here. Trucker's own tree, written before `data/` was known, mirrors `historical_data/` with its
wrapper removed.

## `markPrice` and `indexPrice` may be mislabelled

Unresolved, and worth settling before anything downstream reads them.

Both are matched from paths literally named `futures/daily/mark-klines/<symbol>/<interval>/` and
`index-klines/<symbol>/<interval>/`, and both carry an interval. **An interval belongs to a kline
and to nothing else** — a bar is an aggregate, so the period is part of what the row means, whereas
a mark price of 100 at an instant is complete on its own and how often the venue emits one is a
property of their pipeline rather than of the datum.

So these are klines *of* mark and index price rather than the snapshot series their dataset names
suggest, and either the names are misleading or the modelling is.

## Where to stop reading `data/`

During the six-month overlap both trees carry the same instrument-day under two different schemas.
Catalogue both and the same unit arrives twice from two shapes with no canonical answer to which is
the data — conflicting files mapping to one path, a downloader with nothing to choose by, and gap
analysis that reads a day as covered or missing depending on which tree it looks at.

What is wanted is one date `A` such that everything in `historical_data/` before `A` is also in
`data/`, and everything in `data/` from `A` onward is also in `historical_data/`. Then `accepts`
refuses `data/` from `A` and `historical_data/` before it, decided from the path alone, holding for
keys nobody has listed yet.

**`A` is `2026-02-01`, and the cut is flat.** A venue-wide date has exactly one candidate and the
candidate holds. `funding-rates` exists only in `historical_data/` and starts at the tree's own
floor, `2026-02-01`, so any later `A` loses funding days that were never in `data/`; any earlier one
loses the days between `A` and the floor, where `historical_data/` is empty. That pins `A`. Books,
launching `2026-05-28`, never bind.

**`data/` dies the day `historical_data/` starts, with no exceptions.** Taking the new tree from `A`
is safe in the strong sense for every series both trees carry — every day `data/` holds from that
date onward is also in `historical_data/` — and it is the better branch on the merits, because
`data/` is the one with holes in it.

Two things are knowingly given up, and are **deliberately not carved out**:

- **Nine instruments `historical_data/` never took**, below — about 74 files of trades, all on
  perpetuals delisted by `2026-08-03`.
- **`indexPrice` for the nine coin-margined perpetuals on `2026-06-03`**, 63 files across seven
  intervals, one day.

Both are sparse tails on near-dead instruments, and a rule carrying symbol-level exceptions costs
more than they are worth. Leave them refused.

**Nine instruments traded during the overlap and `historical_data/` never carried them at all**:
`OPUL-USDT`, `ROUTE-USDT`, `UOS-USDT`, `MPLX-USDT`, `LRDS-USDT`, `CVX-USDT`, `DOSE-USDT`, `FSN-USDT`
and `UNB-USDT`, all perpetuals. `data/` is their only source at tick resolution.

The weight is very unevenly spread, and it is worth knowing which of them matter:

| symbol | trade days in window | bytes |
|---|---|---|
| OPUL-USDT | 10 | 633,862 |
| ROUTE-USDT | 10 | 626,272 |
| UOS-USDT | 9 | 623,785 |
| MPLX-USDT | 9 | 617,518 |
| LRDS-USDT | 10 | 606,434 |
| CVX-USDT | 21 | 13,196 |
| DOSE-USDT | 3 | 1,262 |
| FSN-USDT | 1 | 350 |
| UNB-USDT | 1 | 346 |

The first five are 99.8% of it and are worth taking; the last four are rounding error. All nine stop
by `2026-08-03` and none was ever carried by the new tree, so the block is closed and cannot grow.
`data/` is a permanent source for them rather than a temporary one, so nothing is lost by leaving
them there. Reported but not re-checked: the REST kline endpoint still returns daily bars for all of
them, while its trade endpoint serves only recent prints — which would make `data/` the sole source
of their **ticks** and REST a fallback for their bars only.
HTX's own `TEST001-USDT` and `TEST002-USDT` meet the same criterion — one trade day each, inside the
window, absent from `historical_data/` — and are test instruments rather than a loss.

**75 symbols in all still had `data/` files inside the window with no counterpart in
`historical_data/`**, and the other 64 are not a gap: **not one traded inside the window.** They
died earlier — `CEEK-USD` last traded `2024-10-30`, `VRA-USD` `2024-12-22` — and what `data/` still
publishes for them is a frozen placeholder. Excluding a dead instrument's placeholder stream is the
new tree behaving correctly, not an omission.

By market: 27 perpetuals, of which the eleven above traded; 45 dated contracts, none of which
traded, being expiries whose underlying was already dead (`CEEK` and `DORA` weeklies,
`CVX-USDT-240315`, `TOMO-USDT-240329`, `DOSE-USDT-251226`); and three spot leveraged tokens
(`BSV3SUSDT`, `ZEC3LUSDT`, `ZEC3SUSDT`), whose files hold a header row and nothing else.

**The migration itself was atomic.** Not one series in either tree starts in `historical_data/` later
than `data/` was still publishing it — zero, across all 18,753 series both trees carry. Instruments
listed during the overlap appear in both trees on the same day: `ARIA-USDT-PERP` opens in both on
`2026-04-10`, `BARD-USDT-PERP` on `2026-03-06`, `WOJAK-USDT` on `2026-06-30`. A symbol present in
both therefore needs no date of its own.

That is what makes a single cut possible at all. For every series, the latest day only `data/` has
falls before the earliest day only `historical_data/` has, so a valid cut exists everywhere — and
`2026-02-01` is inside every one of those intervals bar the `2026-06-03` index exception above.

### Only one dimension is in play

**A cut is one date, and nothing else is a dimension of it.** That is what lets it be a date rather
than a table, and each of these is why:

- **Datasets arrive together.** `historical_data/` carries 486 perpetuals, 464 of them with klines,
  index, mark and funding all present. The 22 that do not have never been examined, and a perp's
  first settlement landing the day after its listing accounts for that shape of exception.
- **No instrument splits by dataset.** `APR-USDT-PERP` reads like one — klines, index and mark from
  `2026-02-01`, funding and trades only from `2026-08-13` — but it is a relisting seen through a
  `min()`. Both trees carry it identically for `2026-02-01` to `2026-02-25`, twenty-five days each,
  and then it stops in both; the August floor belongs to a second listing that began after `data/`
  had already gone quiet. A first day taken across a discontinuous series is not a floor.
- **Intervals never split.** All seven start on the same day, across 65 series spanning day-one
  migrators, late migrators, recent listings, spot and futures.
- **Market is not independent** — an instrument lives in one.
- **Books are venue-level**, a `historical_data/`-only launch rather than anything per-instrument.

**`trades` cannot date a whole symbol.** A trades file exists only on days that had trades, so a late
trades floor may mean nothing more than a quiet instrument: screening on trades produced 38
candidates of which 13 were exactly that, with klines present from `2026-02-01` all along. A
symbol-level date rests on klines, index, mark and funding, which are written every day an instrument
is listed.

Per series it dates itself fine, and its silence is useful rather than awkward — a stretch neither
tree carries constrains nothing, so any cut inside it is equally valid.

**One qualifier on reading silence as inactivity.** "A trades file exists only on days that had
trades" is `historical_data/`'s behaviour and was `data/`'s until the overlap, but `data/` dropped
trades files for days that plainly did have trades between February and June 2026 — see the holes
above. So a missing `data/` trades file in that span is not evidence the instrument was quiet. The
64 dead symbols above rest on more than that: their klines repeat a final price at zero volume, and
their index and mark series stop dead.

### The rule

**`historical_data/` from `2026-02-01`, `data/` before it**, decided from the path alone and with no
exceptions:

| what | branch | dates |
|---|---|---|
| everything | `data/` | — `2026-01-31` |
| everything | `historical_data/` | `2026-02-01` — |

Everything else follows from it: `funding` and `books` are `historical_data/`-only and start at
their own floors, `option` is `data/`-only and ended in 2021, and the 64 dead symbols are
`data/`-only by the first row rather than by an exception.

**It takes two things in the adapter, because a walk and an update meet the old tree differently.**
`accepts` refuses the superseded duplicates as they are listed, which is what a walk needs. An update
lists nothing — it builds keys from what the catalog already holds — so the same refusal there would
be a rule consulted a million times a pass. Instead the preamble states the tree's end once, as
catalog state: its patterns retired, so no newly listed instrument is created on them, and each of
its series given its own last day, so generation drops them entirely. Neither is discoverable, which
is why the adapter declares it rather than the service inferring it.
