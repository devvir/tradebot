import { probed } from '../scanners/probed';
import { fetchHead } from '../http';
import { halted } from '../context';
import { okxInstruments } from './okx/instruments';
import type { Adapter, ProbedContext } from '../types';
import { declare } from './declare';

/**
 * OKX's archive: nothing can be listed, so its keys are constructed and probed.
 * The venue is described in `docs/venues/OKX.md`.
 */
export const okx: Adapter = declare({
  name:    'okx',
  scanner: probed,

  /** No listing exists, so a probe is what decides whether a key is a file. */
  probes:  true,

  /** An address and one request; what the venue lists goes to the catalog, not into this. */
  getContext: async (): Promise<ProbedContext> => ({
    base:    okx.base,
    keyRoot: okx.keyRoot,
    head:    (url: string) => fetchHead(okx, url, () => halted(okx)),
  }),

  /** Clean at 100 a second and refused at 200 — measured in `docs/venues/OKX.md`. */
  pacing:  { perSecond: 100, concurrency: 100 },

  /** Days behind today a probing pass stops asking: the venue's measured publishing delay, and a day more. */
  probingLag: 3,

  /**
   * A missing key answers `404` and a refusal `403`, so one 404 settles a key:
   * `'drop'` sets it down at once rather than leaving it to be confirmed, which
   * is what keeps probing okx affordable.
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
