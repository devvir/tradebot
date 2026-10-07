import { probed } from '../scanners/probed';
import { fetchHead } from '../http';
import { dateOf } from './bitget/shapes';
import { bitgetInstruments, bitgetUrlSymbol } from './bitget/instruments';
import type { Adapter, ProbedContext } from '../types';
import { declare } from './declare';

/**
 * Bitget's archive: nothing can be listed and a missing key answers `403`, so
 * its keys are constructed and probed. The venue is described in
 * `docs/venues/BITGET.md`.
 */
export const bitget: Adapter = declare({
  name:    'bitget',
  scanner: probed,

  /** Nothing here can be listed: its series are declared, and every pass is an update over them. */
  listable: false,

  /** No listing exists, so a probe is what decides whether a key is a file. */
  probes:  true,

  /** An address and one request; what the venue lists goes to the catalog, not into this. */
  getContext: async (): Promise<ProbedContext> => ({
    base: bitget.base,
    keyRoot: bitget.keyRoot,
    head: (url: string) => fetchHead(bitget, url),
  }),

  /** Under the edge's own limit, near 2,900 a second — measured in `docs/venues/BITGET.md`. */
  pacing:  { perSecond: 2500, concurrency: 500 },

  /** Days behind today a probing pass stops asking: the venue's measured publishing delay, and a day more. */
  probingLag: 4,

  /** What this venue lists today — its only discovery. */
  instruments: bitgetInstruments,
  urlSymbolFor: bitgetUrlSymbol,

  dateOf,

  /** A refusal is ours only where the CDN answered: the bucket's own `403` is about the object. */
  refusesUs: (_status, headers) => headers.get('server') !== 'AmazonS3',

  /**
   * A `403` from the bucket is this venue's 404: the key is set down at once, and
   * asked again by the next update.
   */
  ruleOnFailure: (_row, status, headers) =>
    (status === 403 && headers.get('server') === 'AmazonS3' ? 'drop' : null),

  /**
   * Nothing says how many parts a day has, so each part found asks for the next,
   * and the first miss ends the day.
   */
  expandParts: ({ lastPartFound, nextPart }) => {
    if (lastPartFound === null) return { parts: FIRST_PART, next: after(FIRST_PART) };

    return lastPartFound ? { parts: nextPart, next: after(nextPart) } : null;
  },
});

/** Where every day starts. A day with no first part is a day with nothing in it. */
const FIRST_PART = '001';

/** The part bitget numbers after this one, in the width it numbers them in. */
const after = (part: string): string => String(Number(part) + 1).padStart(3, '0');
