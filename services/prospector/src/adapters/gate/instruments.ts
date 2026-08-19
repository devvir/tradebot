import { fetchJson, metadataGap } from '../../metadata';
import type { Instrument } from '../../types';

/**
 * What gate lists, in the archive's own spelling.
 *
 * **`live` means gate still lists the instrument, never that it can be traded
 * this minute.** The distinction is not academic here: spot's `trade_status` and
 * the futures' `in_delisting` are both listing state — measured, 2,232 tradable
 * against 2 untradable, and no contract in delisting at all — while tradfi's
 * `status` is a market session that closes every evening. See below.
 *
 * **One call per market, and no translation in any of them.** Gate names an
 * instrument the same way in its listing as in its keys — `10SET_USDT`,
 * `BTC_USD`, `ADA_USDT_20240301`, `AAPL` — so the work is which endpoint answers
 * for which tree, not what anything is called.
 *
 * **`tradfi` is one market and one call**, which is worth saying because it does
 * not look like one. It carries 508 equities and leveraged ETFs, 80 FX pairs, 54
 * indices, and 19 each of metals and commodities, all in a flat namespace — so
 * `AAPL`, `AUDCAD` and `GER40` are siblings. Gate publishes the lot from
 * `tradfi/symbols`, which matched every one of the 680 symbols it lists against
 * the archive.
 *
 * **What is deliberately not asked about**: gate's `hk/` and `malta/` trees are
 * separate entities with their own order books, so their `BTC_USDT` is not this
 * venue's. The adapter refuses them at descent, and nothing here should offer
 * instruments for a tree that is not walked.
 */
export const gateInstruments = async (): Promise<Instrument[]> => {
  const out: Instrument[] = [];

  const spot = await fetchJson<Pair[]>(SPOT, 'gate');

  for (const one of spot)
    if (one.id) out.push({ market: 'spot', symbol: one.id, live: one.trade_status !== 'untradable' });

  /**
   * **Two settlement currencies, one market.** A perpetual margined in USDT and
   * one margined in the base coin are the same kind of contract, and the archive
   * files them under names that cannot collide — `BTC_USDT` against `BTC_USD`.
   */
  for (const url of [USDT_PERPS, BTC_PERPS]) {
    await metadataGap();

    for (const one of await fetchJson<Contract[]>(url, 'gate'))
      if (one.name) out.push({ market: 'perp', symbol: one.name, live: one.in_delisting !== true });
  }

  await metadataGap();

  for (const one of await fetchJson<Contract[]>(DELIVERY, 'gate'))
    if (one.name) out.push({ market: 'future', symbol: one.name, live: one.in_delisting !== true });

  await metadataGap();

  const tradfi = await fetchJson<{ data?: { list?: Symbol_[] } }>(TRADFI, 'gate');

  /**
   * **`status` is the trading session, not the listing, and reading it as one
   * delisted this whole market twice a day.**
   *
   * These are tokenised equities and ETFs, so they follow US market hours: the
   * payload carries `open_time`, `close_time` and `next_open_time` beside the
   * status, which is the venue saying as much. Outside 14:30–21:00 UTC — two
   * thirds of every weekday, every weekend and every market holiday — all 680
   * report `closed`.
   *
   * Read as `live`, that retired the entire market on any pass that ran out of
   * hours, and the next pass in hours revived all 382 of them at once — twice a
   * day, on nothing the venue had done.
   *
   * **Appearing in this listing is the listing.** A closed session says nothing
   * about whether gate still publishes the instrument, and what a withdrawal
   * looks like here is a symbol leaving the list entirely.
   */
  for (const one of tradfi.data?.list ?? [])
    if (one.symbol) out.push({ market: 'tradfi', symbol: one.symbol, live: true });

  return out;
};

// ── Internals ─────────────────────────────────────────────────────────────────

interface Pair     { id?: string; trade_status?: string }
interface Contract { name?: string; in_delisting?: boolean }
interface Symbol_  { symbol?: string }

const SPOT       = 'https://api.gateio.ws/api/v4/spot/currency_pairs';
const USDT_PERPS = 'https://api.gateio.ws/api/v4/futures/usdt/contracts';
const BTC_PERPS  = 'https://api.gateio.ws/api/v4/futures/btc/contracts';
const DELIVERY   = 'https://api.gateio.ws/api/v4/delivery/usdt/contracts';
const TRADFI     = 'https://api.gateio.ws/api/v4/tradfi/symbols';
