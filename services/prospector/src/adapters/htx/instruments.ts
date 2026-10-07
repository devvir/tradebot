import { fetchJson, metadataGap } from '../../metadata';
import type { DatabaseSync } from 'node:sqlite';
import type { Instrument } from '../../types';

/** What htx lists, in the archive's spelling: four endpoints, one list — see `docs/venues/HTX.md`. */
export const htxInstruments = async (_db: DatabaseSync): Promise<Instrument[]> => {
  const out: Instrument[] = [];

  const spot = await fetchJson<{ data?: Spot[] }>(SPOT, 'htx');

  for (const one of spot.data ?? []) {
    if (! one.bc || ! one.qc) continue;

    out.push({
      market: 'spot',
      symbol: `${one.bc.toUpperCase()}-${one.qc.toUpperCase()}`,

      /** `suspend` is a halt rather than an ending, so it is still listed. */
      live:   one.state !== 'offline',
    });
  }

  await metadataGap();

  /** A dated contract is underlying, quote and delivery day, the day read from its own field. */
  const futures = await fetchJson<{ data?: Future[] }>(FUTURES, 'htx');

  for (const one of futures.data ?? []) {
    if (! one.symbol || ! one.delivery_date) continue;

    out.push({
      market: 'future',
      symbol: `${one.symbol}-USD-${one.delivery_date.slice(2, 8)}`,
      live:   one.contract_status === LIVE,
    });
  }

  /** Both swap families are perpetuals, differing in what settles them. */
  for (const url of [COIN_SWAP, LINEAR_SWAP]) {
    await metadataGap();

    const body = await fetchJson<{ data?: Swap[] }>(url, 'htx');

    for (const one of body.data ?? []) {
      if (! one.contract_code) continue;

      out.push({
        market: 'perp',
        symbol: one.contract_code,
        live:   one.contract_status === LIVE,
      });
    }
  }

  return out;
};

// ── Internals ─────────────────────────────────────────────────────────────────

interface Spot   { sc?: string; bc?: string; qc?: string; state?: string }
interface Future { symbol?: string; delivery_date?: string; contract_status?: number }
interface Swap   { contract_code?: string; contract_status?: number }

/** htx says a contract is trading with a number, and only this one means it. */
const LIVE = 1;

const SPOT        = 'https://api.huobi.pro/v2/settings/common/symbols';
const FUTURES     = 'https://api.hbdm.com/api/v1/contract_contract_info';
const COIN_SWAP   = 'https://api.hbdm.com/swap-api/v1/swap_contract_info';
const LINEAR_SWAP = 'https://api.hbdm.com/linear-swap-api/v1/swap_contract_info';
