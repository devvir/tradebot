import { fetchJson, metadataGap } from '../../metadata';
import type { DatabaseSync } from 'node:sqlite';
import type { Instrument } from '../../types';

/** What htx lists, in the archive's spelling: four endpoints, one list — see `docs/venues/HTX.md`. */
export const htxInstruments = async (_db: DatabaseSync): Promise<Instrument[]> => {
  const out: Instrument[] = [];

  const spot = await fetchJson<{ data?: Spot[] }>(SPOT, 'htx', refusedV2);

  for (const one of listOf(spot, SPOT)) {
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
  const futures = await fetchJson<{ data?: Future[] }>(FUTURES, 'htx', refused);

  for (const one of listOf(futures, FUTURES)) {
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

    const body = await fetchJson<{ data?: Swap[] }>(url, 'htx', refused);

    for (const one of listOf(body, url)) {
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

/**
 * **Every answer is a `200`; the body is what says whether it worked**, and read
 * without that an error reads as an empty list — every instrument on that
 * endpoint delisted. The derivative endpoints answer `status: "ok"` and nothing
 * else when they worked.
 */
const refused = (body: unknown): boolean => (body as { status?: unknown }).status !== 'ok';

/** The spot endpoint, which may speak either dialect: `status` or a numeric `code`. */
const refusedV2 = (body: unknown): boolean => {
  const { status, code } = body as { status?: unknown; code?: unknown };

  return status === 'error' || (code !== undefined && code !== 200);
};

/** An answer's records, or a failure: a body without a list is not an empty listing. */
const listOf = <T>(body: { data?: T[] }, url: string): T[] => {
  if (! Array.isArray(body.data)) throw new Error(`htx instruments: no list in the answer from ${url}`);

  return body.data;
};

interface Spot   { sc?: string; bc?: string; qc?: string; state?: string }
interface Future { symbol?: string; delivery_date?: string; contract_status?: number }
interface Swap   { contract_code?: string; contract_status?: number }

/** htx says a contract is trading with a number, and only this one means it. */
const LIVE = 1;

const SPOT        = 'https://api.huobi.pro/v2/settings/common/symbols';
const FUTURES     = 'https://api.hbdm.com/api/v1/contract_contract_info';
const COIN_SWAP   = 'https://api.hbdm.com/swap-api/v1/swap_contract_info';
const LINEAR_SWAP = 'https://api.hbdm.com/linear-swap-api/v1/swap_contract_info';
