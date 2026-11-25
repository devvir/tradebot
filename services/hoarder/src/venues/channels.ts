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
 * Each venue collects two symbols, each with a trade channel and a book
 * channel. Hoarder takes no REST snapshots: of a book it publishes what the
 * book channel streams and nothing else. For what each venue streams, see the
 * *WebSocket* section of its doc under `docs/venues/`, where one exists.
 */
export const VENUE_CHANNELS: Readonly<Record<string, readonly string[]>> = {
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
