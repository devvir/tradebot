import { probed } from '../scanners/probed';
import { fetchHead } from '../http';
import { okxInstruments, symbolRanges } from './okx/instruments';
import type { Adapter, OkxContext } from '../types';
import { declare } from './declare';

/**
 * OKX's archive: nothing can be listed, so its keys are constructed from the
 * ranges `okx/instruments.ts` establishes. The venue is described in
 * `docs/venues/OKX.md`.
 */
export const okx: Adapter = declare({
  name:    'okx',
  scanner: probed,

  /** No listing exists, so a probe is what decides whether a key is a file. */
  probes:  true,

  /** The ranges keys are built inside, brought up to date first — see `okx/instruments.ts`. */
  getContext: async (db): Promise<OkxContext> => {
    return {
      ranges: await symbolRanges(db, okx),
      base:   okx.base,
      keyRoot: okx.keyRoot,
      head:   (url: string) => fetchHead(okx, url),
    };
  },

  /** Clean at 100 a second and refused at 200 — measured in `docs/venues/OKX.md`. */
  pacing:  { perSecond: 100, concurrency: 100 },

  /** Days behind today a probing pass stops asking: the venue's measured publishing delay, and a day more. */
  probingLag: 3,

  /**
   * A missing key answers `404` and a refusal `403`, so one 404 settles a key.
   * TEMPORARY: `'drop'` sets it down at once instead of leaving it to be
   * confirmed — see `docs/planning/CATALOG.md`.
   */
  ruleOnFailure: (_row, status) => (status === 404 ? 'drop' : null),

  /** What this venue lists today — its only discovery. */
  instruments: okxInstruments,

  /** Nothing here can be listed: its series are declared, and every pass is an update over them. */
  listable: false,

  dateOf: (path) => {
    const daily = /(\d{4})-(\d{2})-(\d{2})\.(?:zip|tar\.gz)$/.exec(path);

    if (daily) return `${daily[1]}${daily[2]}${daily[3]}`;

    const monthly = /(\d{4})-(\d{2})\.zip$/.exec(path);

    return monthly ? `${monthly[1]}${monthly[2]}` : null;
  },

});
