import { fetchJson, metadataGap } from '../../metadata';
import type { DatabaseSync } from 'node:sqlite';
import type { Instrument } from '../../types';

/**
 * What htx lists, in the archive's own spelling.
 *
 * **Four endpoints on two hosts, because htx files its markets separately.**
 * Spot lives on the exchange API; the three derivative families each have their
 * own service on `api.hbdm.com`. None of that reaches the core — it asks once
 * and gets one list.
 *
 * **Every market needs translating, and each was checked against the archive
 * rather than assumed:**
 *
 * ```
 * spot          btcusdt + bc/qc   -> BTC-USDT            609 of 609 matched
 * dated futures BTC + 20260828    -> BTC-USD-260828        8 of 8
 * coin swap     BTC-USD           -> BTC-USD
 * linear swap   BTC-USDT          -> BTC-USDT           301 of 303, the two
 *                                                       missing listed that day
 * ```
 *
 * The spot case is the reason `Instrument.symbol` is defined as the archive's
 * spelling: htx answers `btcusdt` where its files say `BTC-USDT`, and the split
 * between base and quote is not recoverable from the joined name — `bc` and `qc`
 * are, which is why they are read instead of the symbol being parsed.
 *
 * **The perpetuals pass through unchanged, and their `-PERP` is not missing.**
 * The offered tree writes `BTC-USDT-PERP` in its keys, but that suffix is a
 * constant of the pattern rather than part of the instrument — see `instrumentOf`
 * in `htx.ts` — and `data/` calls the same contract `BTC-USDT`. Appending it here
 * would name one instrument differently from the branch that carries its history.
 *
 * **Only spot states an ending.** It returns 1,547 `offline` symbols beside 609
 * `online`, which is the venue saying an instrument is finished. The derivative
 * endpoints answer with what is trading and nothing else, so there a symbol
 * leaving the list is the only ending stated.
 */
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

  /**
   * **A dated contract is named by what it settles**, which the archive spells
   * as underlying, quote and the delivery day: `BTC-USD-260828`. htx's own name
   * for it joins two of those and drops the third, so the delivery date is read
   * from its own field rather than parsed back out of the code.
   */
  const futures = await fetchJson<{ data?: Future[] }>(FUTURES, 'htx');

  for (const one of futures.data ?? []) {
    if (! one.symbol || ! one.delivery_date) continue;

    out.push({
      market: 'future',
      symbol: `${one.symbol}-USD-${one.delivery_date.slice(2, 8)}`,
      live:   one.contract_status === LIVE,
    });
  }

  /**
   * **Both swap families are perpetuals**, differing in what settles them —
   * coin-margined `BTC-USD` and stablecoin-margined `BTC-USDT`. The archive
   * files them under one market with names that cannot collide, and marks what
   * they are with the suffix its keys carry.
   */
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
