/**
 * What hoarder subscribes to, per venue, at startup.
 *
 * Deliberately code and not configuration: which venues exist and what they
 * stream changes rarely and never per-deployment, so a rebuild is the right
 * cost. `HOARDER_VENUES` still selects which of these a given instance runs —
 * that is a deployment concern, this is not.
 *
 * Channels are written in the venue's own subscription syntax, fully expanded.
 * Nothing is templated or derived, so what a venue collects is legible here
 * without tracing preset expansion through another package.
 *
 * ⚠ **The four non-BitMEX lists below are provisional.** They were written before the
 * source survey in `docs/planning/VENUE_SOURCES.md`, which concludes that trade feeds are
 * largely redundant with each venue's bulk/REST history, and that book feeds — the thing
 * actually worth streaming — are diff streams needing interleaved REST snapshots that this
 * service cannot yet take. Symbol coverage is a two-symbol placeholder. Read that document
 * before trusting or extending these lists. BitMEX is not provisional: it mirrors what
 * production collects today.
 */
export const VENUE_CHANNELS: Readonly<Record<string, readonly string[]>> = {
  /**
   * Mirrors what BitMEX collection has been running: the archive set, with the
   * book taken per-pool. `orderBookL2` is fanned because its bare subscription
   * streams the fused `Aggregated` book — the per-pool data exists only behind
   * an explicit `::Pool` filter, and BitMEX rejects two pools of one table on a
   * single socket, so each lands on its own connection.
   *
   * `chat`, `announcement`, `connected` and `publicNotifications` ride the
   * platform endpoint; the rest are realtime.
   */
  bitmex: [
    'announcement',
    'chat',
    'connected',
    'instrument',
    'liquidation',
    'orderBookL2::Primary',
    'orderBookL2::Secondary',
    'publicNotifications',
  ],

  /**
   * Raw Binance stream names. Per-symbol: Binance has no all-symbol book or
   * trade stream, so every symbol collected is listed here.
   *
   * Note Binance acks an unknown stream as cheerfully as a real one, so a typo
   * in this list produces silence, not an error — see `binance.ts`.
   */
  binance: [
    'btcusdt@aggTrade',
    'btcusdt@depth@100ms',
    'ethusdt@aggTrade',
    'ethusdt@depth@100ms',
  ],

  /** `<topic>` — Bybit v5 linear perpetuals. */
  bybit: [
    'publicTrade.BTCUSDT',
    'orderbook.200.BTCUSDT',
    'publicTrade.ETHUSDT',
    'orderbook.200.ETHUSDT',
  ],

  /** `<channel>:<instId>` — split into OKX's arg object on subscribe. */
  okx: [
    'trades:BTC-USDT',
    'books:BTC-USDT',
    'trades:ETH-USDT',
    'books:ETH-USDT',
  ],

  /** `<channel>:<symbol>` — one symbol per subscription, so each acks alone. */
  kraken: [
    'trade:BTC/USD',
    'book:BTC/USD',
    'trade:ETH/USD',
    'book:ETH/USD',
  ],
};
