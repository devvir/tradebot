import { fetchJson, metadataGap } from '../../metadata';
import type { Instrument } from '../../types';

/**
 * What gate lists, in the archive's spelling: one call a market, and no
 * translation. `live` is whether gate still lists it, not whether it trades now.
 */
export const gateInstruments = async (): Promise<Instrument[]> => {
  const out: Instrument[] = [];

  const spot = await fetchJson<Pair[]>(SPOT, 'gate');

  for (const one of spot)
    if (one.id) out.push({ market: 'spot', symbol: one.id, live: one.trade_status !== 'untradable' });

  /** Both settlement currencies are one market: perpetuals. */
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

  /** Tradfi's `status` is a market session, which closes daily, so listing is what counts. */
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
