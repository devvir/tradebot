import type { Searched } from '../../types';

/**
 * How the archive files an instrument bitget's API names. Rules where a rule
 * holds, and the venue's own search for the rest — see `docs/venues/BITGET.md`.
 */

/** The archive spells every instrument in upper case, whatever the form displays. */
const clean = (symbol: string): string => symbol.replaceAll('/', '').toUpperCase();

/** The month a quarterly contract expires in, as the futures calendar writes it. */
const MONTH_CODE: Record<number, string> = { 3: 'H', 6: 'M', 9: 'U', 12: 'Z' };

/** The last Friday of a month, when a quarterly contract settles. */
const lastFriday = (year: number, month: number): Date => {
  const end = new Date(Date.UTC(year + (month === 12 ? 1 : 0), month % 12, 0));

  end.setUTCDate(end.getUTCDate() - ((end.getUTCDay() - 5 + 7) % 7));

  return end;
};

/** A dated contract's archive name from its display name: `BTCUSD0327` is `BTCUSDH26`. */
const dated = (symbol: string): string | null => {
  const found = /^(.*?)(\d{2})(\d{2})$/.exec(symbol);

  if (! found) return null;

  const [, base, mm, dd] = found;
  const month = Number(mm);

  if (! (month in MONTH_CODE)) return null;

  const now = new Date().getUTCFullYear();

  for (let year = now - 3; year <= now + 3; year++) {
    const settles = lastFriday(year, month);

    if (settles.getUTCDate() === Number(dd))
      // Coin-margined loses its `USD` here exactly as it does undated:
      // `BTCUSD_CM_1225` is filed `BTCCMZ26`, not `BTCUSDCMZ26`.
      return `${base!.replace(/USD_CM_?$/, 'CM').replace(/_$/, '')}`
        + `${MONTH_CODE[month]}${String(year).slice(2)}`;
  }

  return null;
};

/**
 * The archive's spelling by rule: `…PERP` for USDC-margined perpetuals, `…CM` for
 * coin-margined, an expiry code for quarterlies.
 */
export const pathSymbolOf = (market: string, symbol: string): string => {
  const name = clean(symbol);

  if (market !== 'FUTURES') return name;

  if (name.endsWith('USDC'))   return `${name.slice(0, -4)}PERP`;
  if (name.endsWith('USD_CM')) return `${name.slice(0, -6)}CM`;

  return dated(name) ?? name;
};

/**
 * Which of the archive's two lines a pattern writes to, `SPOT` or `FUTURES`: a
 * rename is spelled differently on each.
 */
export const halfOf = (pattern: string): string =>
  /\/SP\/|SPBL|_SP_|depth(?:_500)?(?:_month)?\/[^/]+\/1\//.test(pattern) ? 'SPOT' : 'FUTURES';

/**
 * Ask the venue's search how it files each instrument named, one request each. A
 * name it does not know keeps the rule's spelling.
 */
export const archiveNamesOf = async (
  symbols: readonly string[],
): Promise<Map<string, Searched>> => {
  const out = new Map<string, Searched>();

  for (const symbol of symbols) {
    /** A POST, which `fetchJson` does not speak. A failure only leaves the rule's spelling in place. */
    const body = await fetch(SEARCH, {
      method:  'POST',
      headers: { 'content-type': 'application/json;charset=UTF-8' },
      body:    JSON.stringify({ searchContent: symbol, showOpenTime: true, languageType: 0 }),
      signal:  AbortSignal.timeout(ASK_MS),
    }).then(res => res.json() as Promise<{ code?: string; data?: Record<string, {
      symbolCode?: string; symbolCodeDisplayName?: string; symbolId?: string;
    }[]> }>).catch(() => null);

    // Only `00000` is an answer here; anything else says nothing about the name.
    if (! body || String(body.code) !== '00000') continue;

    for (const bucket of ['contract', 'spot', 'margin'] as const)
      for (const row of body.data?.[bucket] ?? [])
        if (row.symbolCodeDisplayName === symbol && row.symbolCode)
          out.set(symbol, { spelling: row.symbolCode, token: tokenIn(row.symbolId) });
  }

  return out;
};

/** The margin line a `symbolId` ends in — `BTCUSDT_UMCBL` — where it is one the archive uses. */
const tokenIn = (symbolId: string | undefined): string | null => {
  const tail = symbolId?.split('_').pop();

  return tail && TOKENS.has(tail) ? tail : null;
};

/** Every margin line the archive is known to file under. */
const TOKENS = new Set(['SPBL', 'UMCBL', 'DMCBL', 'CMCBL']);

const SEARCH = 'https://www.bitget.com/v1/mix/index/search/trade/coin';

/** Long enough for a slow reply, short enough that a hung one cannot hold a pass. */
const ASK_MS = 20_000;
