import type { Instrument } from '../../types';

/**
 * How bitget spells a key, and how one is read back — its eras, tokens and parts
 * are in `docs/venues/BITGET.md`.
 */

/**
 * The market of a listed instrument: spot, perp or future where it is crypto,
 * and `tradfi` — which is refused — for everything else. Spot refuses whatever
 * is not typed `crypto`; futures read `isRwa`, which is the wider flag.
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
 * The token an instrument's files are filed under. Fixed by market and dataset
 * except for futures trades, where it is the margin type of the category the
 * venue lists the instrument in. An unknown category takes `UMCBL` and says so.
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
 * The date a path ends in: eight digits for a day, six for a month, eight
 * tried first. A path this does not read is discarded without a word.
 */
export const dateOf = (path: string): string | null => {
  const found = /(\d{8}|\d{6})(?:_\d{3})?\.zip$/.exec(path);

  return found ? found[1]! : null;
};
