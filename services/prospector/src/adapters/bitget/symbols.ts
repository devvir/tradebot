import type { Searched } from '../../types';

/**
 * How bitget's API names an instrument, and how its archive files one.
 *
 * **They are different questions.** The API names whatever trades today; a path
 * names whoever held that ticker when the file was written, and cannot be
 * renamed afterwards. Bitget reuses tickers, so the plain spelling belongs to
 * the first holder and every later one is filed somewhere else - see
 * `docs/venues/BITGET.md`.
 *
 * **The venue answers this itself.** Its trading-platform search returns, for
 * any instrument it lists, the `symbolCode` its archive files under. That is the
 * mapping, from the venue, for whatever it lists today - so nothing here
 * enumerates it. What is derived is only what a rule genuinely reaches, and a
 * name the search does not know keeps its own spelling rather than being guessed
 * at from a table that was true when somebody swept.
 */

/** The archive spells every instrument in upper case, whatever the form displays. */
const clean = (symbol: string): string => symbol.replaceAll('/', '').toUpperCase();

/** The month a quarterly contract expires in, as the futures calendar writes it. */
const MONTH_CODE: Record<number, string> = { 3: 'H', 6: 'M', 9: 'U', 12: 'Z' };

/**
 * The last Friday of a month, which is when bitget's quarterly contracts settle
 * and therefore what its `MMDD` display name is naming.
 */
const lastFriday = (year: number, month: number): Date => {
  const end = new Date(Date.UTC(year + (month === 12 ? 1 : 0), month % 12, 0));

  end.setUTCDate(end.getUTCDate() - ((end.getUTCDay() - 5 + 7) % 7));

  return end;
};

/**
 * A dated contract's archive name, from the expiry its display name states.
 *
 * `BTCUSD0327` is the contract expiring on 27 March, and only one year has its
 * last Friday on that date - 2026 - so it files as `BTCUSDH26`. Derivable in
 * both directions, which is why it is a rule here rather than a row somewhere.
 */
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
 * The archive's spelling of a listed instrument, from the rules that hold.
 *
 * USDC-margined perpetuals file as `…PERP`, coin-margined as `…CM`, quarterlies
 * under their expiry code. Everything else files under the name the venue uses -
 * **which is right until a ticker is re-issued**, and that is the case the
 * search endpoint answers rather than this.
 */
export const pathSymbolOf = (market: string, symbol: string): string => {
  const name = clean(symbol);

  if (market !== 'FUTURES') return name;

  if (name.endsWith('USDC'))   return `${name.slice(0, -4)}PERP`;
  if (name.endsWith('USD_CM')) return `${name.slice(0, -6)}CM`;

  return dated(name) ?? name;
};

/**
 * Which of the archive's two lines a shape writes to: `SPOT` or `FUTURES`.
 *
 * **The archive divides into exactly two, and that is all its paths know.** Every
 * bitget key declares its line - `SP`, `SPBL` and the `/1/` depth stream are
 * spot; the margin tokens and `/2/` are futures.
 *
 * Read from the pattern rather than the market because it is needed where no
 * instrument is in hand: `bitgetUrlSymbol` is asked per shape, and the two lines
 * spell one rename differently - `AISLEEPLESSUSDT` is `AIUSDT` in futures and
 * `$AIUSDT` in spot.
 */
export const halfOf = (pattern: string): string =>
  /\/SP\/|SPBL|_SP_|depth(?:_500)?(?:_month)?\/[^/]+\/1\//.test(pattern) ? 'SPOT' : 'FUTURES';

/**
 * Ask the venue how it files the instruments named, one request each.
 *
 * **Asked only about what the catalog has never seen**, which is a handful on an
 * ordinary pass and nothing at all on most. The reply is categorical - a single
 * search term returns that instrument's own `symbolCode` - where a sweep of
 * thousands of names at once leaves the pairing to be inferred.
 *
 * A name it does not know keeps whatever the rules derived. That is the coin-
 * margined family, which the search does not list at all, and anything listed so
 * recently that the archive has not met it either.
 */
export const archiveNamesOf = async (
  symbols: readonly string[],
): Promise<Map<string, Searched>> => {
  const out = new Map<string, Searched>();

  for (const symbol of symbols) {
    /**
     * **Its own request rather than `fetchJson`**, which speaks GET: this
     * endpoint takes the search term in a POST body. A failure is not fatal -
     * the rules already produced a spelling, and this only improves on it.
     */
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

/**
 * The margin line a `symbolId` names, which is its last underscore-separated
 * part: `BTCUSDT_UMCBL`, `RAAONUSDT_SPBL`.
 *
 * **Only a token this archive actually uses is believed.** The field is the
 * venue's internal id and nothing promises its shape, so an unrecognised tail is
 * read as "the reply did not say" rather than as a token — which keeps a
 * malformed id from putting an instrument's trades under a directory that
 * cannot exist.
 */
const tokenIn = (symbolId: string | undefined): string | null => {
  const tail = symbolId?.split('_').pop();

  return tail && TOKENS.has(tail) ? tail : null;
};

/** Every margin line the archive is known to file under. */
const TOKENS = new Set(['SPBL', 'UMCBL', 'DMCBL', 'CMCBL']);

const SEARCH = 'https://www.bitget.com/v1/mix/index/search/trade/coin';

/** Long enough for a slow reply, short enough that a hung one cannot hold a pass. */
const ASK_MS = 20_000;
