import type { Instrument } from '../../types';

/**
 * How bitget spells a key, and how one is read back.
 *
 * **Four facts, all measured** — against 4.8M rows of the venue's own download
 * index, the 1.46M files held locally, and the CDN itself where the two
 * disagreed:
 *
 * - **The naming changed on 2024-04-19.** Before it, the symbol and the token
 *   are repeated inside the filename; after it, the token is a directory and the
 *   filename is the date alone. The change is a clean cut: no old-era key
 *   carries a date on or after that day, and only ~440 new-era keys carry one
 *   before it — targeted backfills on a handful of recurring dates where the old
 *   name is absent and the new one is the only copy.
 * - **The token is fixed per market and dataset**, except for futures trades,
 *   where it follows the margin type. Candlesticks use `UMCBL` for *both* margin
 *   types, coin-margined instruments included.
 * - **Depth exists only in the new era**, starting 2024-07-09 in both markets.
 * - **A day of trades is cut into parts of 100,000 rows**, `_001` upward, and
 *   nothing in the path says how many there are.
 *
 * So each `(market, dataset, symbol)` that spans the cut is **two series with
 * adjacent ranges** — the same arrangement okx's books have either side of the
 * day their prefix gained `pro/`.
 */

/**
 * Which market an instrument belongs to, from what the venue says about it.
 *
 * **Three markets are catalogued and everything else is refused.** Bitget lists
 * roughly 1,500 tokenised equities, ETFs, metals and currency pairs beside its
 * crypto; `tradfi` is the answer this returns for all of them, and
 * `bitgetInstruments` drops anything that answers it. Nothing downstream ever
 * sees one - see `EXCLUDED` there for why.
 *
 * **Both fields are present on every instrument of every category**, measured
 * over all 2,941 the venue lists, so nothing here is decided by a missing value.
 *
 *   symbolType   crypto | stock | metal | commodity
 *   isRwa        YES | NO          on the futures categories only
 *   type         perpetual | delivery
 *
 * The spot rule refuses anything that is **not** `crypto`, so a type bitget
 * invents tomorrow is refused rather than admitted by omission. The futures rule
 * reads `isRwa` rather than `symbolType` because it is the wider of the two:
 * eleven contracts the venue types `crypto` are flagged `YES`, and they are
 * `HPQ`, `BHP`, `RIO`, `VALE`, `EURUSD`, `USDJPY` and the like.
 */
export const marketOf = (one: {
  market:      string;
  symbolType?: string;
  isRwa?:      string;
  type?:       string;
}): string => {
  if (one.market === 'SPOT') return one.symbolType === 'crypto' ? 'spot' : 'tradfi';

  if (one.isRwa === 'YES')      return 'tradfi';
  if (one.type  === 'delivery') return 'future';

  return 'perp';
};

/**
 * The token an instrument's files are filed under.
 *
 * Five of the six combinations are a property of the shape alone. **Futures
 * trades is not**: its token is the instrument's margin type, and nothing in the
 * path or the symbol reveals which — only the category the venue lists it under
 * does. So this is asked about an instrument rather than about a market, and the
 * one caller that builds these keys has an instrument in hand.
 *
 * Getting it wrong is expensive and quiet. A coin-margined symbol asked for
 * under `UMCBL` answers `403`, which at this venue means "not there", so the
 * instrument reads as one that publishes nothing. That has happened here in the
 * other direction — candlesticks asked for under `DMCBL`, 55 probes out of 55
 * missing by one path segment, and the dataset written off as dead.
 *
 * **A category nobody has seen falls back to `UMCBL` and says so.** Guessing the
 * common case keeps a new contract type collecting candlesticks and depth while
 * somebody looks at the log; refusing outright would lose those too, over a
 * token that is one API call to confirm.
 */
export const tokenOf = (instrument: Instrument, dataset: string): string => {
  if (dataset === 'depth')  return instrument.market === 'SPOT' ? '1' : '2';
  if (dataset === 'klines') return instrument.market === 'SPOT' ? 'SP' : 'UMCBL';

  if (instrument.market === 'SPOT') return 'SPBL';

  return MARGINS[instrument.category ?? ''] ?? 'UMCBL';
};

/** Whether the venue has started listing a contract type these shapes do not know. */
export const unknownMargin = (instrument: Instrument): boolean =>
  instrument.market !== 'SPOT' && ! ((instrument.category ?? '') in MARGINS);

/** Which token each futures category files its trades under, measured. */
const MARGINS: Record<string, string> = {
  'USDT-FUTURES': 'UMCBL',
  'COIN-FUTURES': 'DMCBL',
  'USDC-FUTURES': 'CMCBL',
};

/**
 * The date a bitget path carries, which every shape puts last.
 *
 * **Two widths, because the archive publishes two grains.** A daily key ends in
 * `YYYYMMDD` and a monthly one — the `*_month/` trees — in `YYYYMM`, and the
 * only thing separating them is how many digits there are. Eight is tried first
 * and anchored to the end, or a daily stamp would match on its last six and
 * every daily file would be filed under a month that does not exist.
 *
 * **A path this cannot read is a path the catalog discards**, before it ever
 * reaches `wip`, with no row and no warning anywhere — so a shape added to the
 * seed whose stamp this does not match contributes nothing and looks exactly
 * like an instrument the archive has never held. That is not hypothetical: the
 * four monthly trees were seeded against a six-digit stamp this expression only
 * matched at eight, and 11,903 series generated their keys, had every one
 * thrown away here, and reported no files at all.
 *
 * `_NNN` is the trades part suffix, which only the daily trades shapes carry.
 */
export const dateOf = (path: string): string | null => {
  const found = /(\d{8}|\d{6})(?:_\d{3})?\.zip$/.exec(path);

  return found ? found[1]! : null;
};
