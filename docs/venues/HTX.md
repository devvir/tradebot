# HTX

What htx's published archive actually contains, established by asking htx rather than by reading
its documentation.

## Two archives in one bucket: one offered, one merely reachable

HTX publishes **two separate trees**, and the difference between them is not depth — it is what is
promised.

| | `historical_data/` | `data/` |
|---|---|---|
| status | **announced and offered** | reachable, never announced |
| guarantee | present, complete, maintained | **none whatsoever** |
| depth | ~6 months, rolling | ~6 years |
| BTC spot, earliest | `2026-02-01` | `2020-06-01` |
| current through | today | `2026-08-04` — equally current |
| symbols | dashed, `BTC-USDT` | undashed, `BTCUSDT` |
| markets | `spot`, `futures` | `spot`, `future`, `swap`, `linear-swap`, `option` |
| layout | `<market>/daily/<dataset>/<SYMBOL>/` | `<dataset>/<market>/daily/<SYMBOL>/` |

Measured, both the same day:

```
historical_data/spot/daily/trades/BTC-USDT/   earliest  2026-02-01
data/trades/spot/daily/BTCUSDT/               earliest  2020-06-01
data/trades/spot/daily/0GUSDT/                latest    2026-08-04
```

`data/` also exposes market types the offered tree does not separate at all — `swap`, `linear-swap`
and `option` — so it is wider as well as deeper.

### What each tree is worth

- **The guarantee is six months.** Anything relying on HTX being *reliably* available should assume
  that and no more.
- **The availability today is six years.** And precisely because nothing promises `data/` will be
  there next month, an unannounced tree is worth taking *sooner* than an announced one, not later.

HTX is surveyed **from the bucket root**, with `assets/` and `test/` refused, because descent
guarantees nothing above where it starts: a root of `historical_data/` keeps the sibling tree out of
the search entirely. That is the general rule — a hardcoded root reintroduces one level up precisely
the omission that discovering prefixes exists to prevent — and it applies identically to binance's
`data3/liquidationSnapshot/`.

### Open

Whether the two trees hold the same trades in different shapes, or genuinely different coverage, has
**not** been checked — the symbol naming and market taxonomy differ, so they are not trivially
comparable. Nor is it established whether `data/` is pruned at some horizon of its own. What is
established is that it holds 2020 data today, which a six-month window cannot.

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
