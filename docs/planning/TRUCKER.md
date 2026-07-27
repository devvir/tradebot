# Trucker — what is still ahead

Trucker is built and collects **107 datasets across 7 venues**.
**[docs/services/TRUCKER.md](../services/TRUCKER.md) is the authoritative document** for what
it collects, how, and why. Nothing already implemented is described here.

This document covers only what has not been done: series that exist but are not reachable,
venues with no adapter, and the questions still open.

Companion to [VENUE_SOURCES.md](VENUE_SOURCES.md), which decides *what is worth collecting and
from which source*.

## Series known to exist but not reachable

Every category each collected venue publishes is now fetched, with these exceptions — all of
them blocked on a URL pattern rather than a decision:

- **OKX `aggtrades`** — documented with the same daily pattern as `trades`, but every URL tried
  returns 404. Whether the pattern is wrong or the category is unpublished is not established.
- **Gate spot candlesticks** — `spot/candlesticks_1m` 404s while the futures equivalent works.
  Tried `candlesticks`, `candles`, `kline`, `klines` as well. The futures intervals 15m, 30m
  and 8h also 404, so those genuinely do not exist rather than being missed.
- **Gate TradFi** — the portal offers a TradFi tab alongside Spot, USDT-M and BTC-M. Its `biz`
  token is not `tradfi`, `trad_fi` or `futures_tradfi`; all 404. Needs a look at what the
  portal actually requests for that tab.

## Venues with no adapter

Ranked by derivatives market share, since that is why each is interesting; judged by whether
its history can actually be obtained, since that is why it can be used. **A venue with no
accessible history cannot be trained against, whatever its liquidity.**

| Venue | Share | Archive | Verdict |
|---|---|---|---|
| MEXC | 5.4 % | none found | no bulk archive |
| Deribit | 0.8 % | none — REST only | no bulk archive |
| Kraken | n/a | Google Drive ZIPs, manual | obtainable, not automatable as-is |
| BitMEX | 0.9 % | S3 buckets | already collected by `courier` |

**Kraken.** No CDN or bucket. The support pages hand out Drive links: one ZIP with all pairs
from the beginning of each market, plus a Drive folder of quarterly incremental ZIPs. OHLCVT is
distributed the same way, separately. Verified locally: `TimeAndSales_Combined/{PAIR}.csv`,
1,119 pairs, 46 GB, three columns (`unix_seconds,price,volume`), 2013-10-06 → 2025-12-31 — no
side, no trade id, second resolution. REST fills those gaps. Automation is awkward: Drive has
no stable listing without the API, large files interpose a virus-scan confirmation token, and
file IDs are opaque. The quarterly cadence makes manual placement defensible.

**MEXC and Deribit** publish nothing in bulk. Both serve working REST market-data APIs, and
both appear in Tardis.dev's paid catalogue — itself evidence that free bulk history is not
published. Deribit's history *is* fully obtainable via `get_last_trades_by_instrument` paged by
`trade_seq` at 20 RPS, but by API paging, not download — a different service's job than
trucker. MEXC's `market-data-download` page is JS-driven and advertises only "Spot Chart Data";
its URL patterns need a devtools session.

Probes that found nothing, so they are not retried blindly:

```
MEXC     contract.mexc.com/data/ 403 · data.mexc.com DNS fail · static.mexc.com/data/ DNS fail
Deribit  datashop.deribit.com DNS fail · static.deribit.com 404 · deribit.com/data/ 200 (unexamined)
```

The striking result across the whole survey: **share and data availability are almost
uncorrelated.** KuCoin at 2.2 % publishes more than OKX at 17.7 % did before its portal was
decoded, and Gate at 1.7 % publishes more than anyone except Binance.

## Open questions

1. **Bitget's floor is neither fixed nor rolling — it is a filename change.** 2024-04-18 is
   where the constructed URL shape begins; bitget's own index lists spot klines and trades
   back to 2018-07-25 under an older name that no template reaches. Its portal publishes a
   public list endpoint, as does OKX's — both are now read by their adapters. See
   `docs/venues/BITGET.md` and `docs/venues/OKX.md`.

   **HTX is the venue whose archive is genuinely perishable**: it serves a rolling window
   roughly six months deep — `BTC-USDT` spot trades start 2026-02-01 — so what it published
   last year is gone. See `docs/venues/HTX.md`.
2. **How far back does each OKX book instrument go?** BTC-USD-SWAP starts 2024-03 at 400lv and
   2025-11-01 at 5000lv, but that is one instrument — the portal's "March 2023" presumably
   refers to the earliest symbols. The per-symbol `listTime` bound handles it either way; this
   is only a question of how many probes are wasted below each symbol's real start.
3. **`deribit.com/data/` returns 200** — the one unexamined loose end.
4. **Kraken's mechanism** — Drive API with a key, or accept manual placement and have trucker
   only verify and index what a human dropped in?
5. **Integrity beyond checksums.** Only Binance and KuCoin ship `.CHECKSUM`. A verify pass that
   re-reads what is on disk — and can distinguish a corrupt file from a missing one — does not
   exist.
6. **Pruning.** The policy is collect-everything-then-prune. Once normalisation begins and the
   value of each series is known, the bulky ones that earn nothing should be dropped. Books
   dominate: OKX's two depths together are ~235 MB per symbol-day, Gate `futures_usdt` ~765 MB.

## Next steps

1. Normalise what is landing, and use what that reveals to prune.
2. Collect what bitget's real floor unlocked — roughly six years of spot and futures history
   below the filename change, reached through its index rather than by constructing URLs.
3. Chase the three unreachable series above if they turn out to matter.
4. Decide Kraken's mechanism.
