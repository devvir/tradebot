import type { Candidate } from '../types';

/**
 * An origin of raw data: trucker's archive tree today, the REST and websocket
 * collectors later, and vault's BitMEX history.
 *
 * Each lays its files out differently, so each knows how to walk itself and how
 * to read meaning out of a path. Everything downstream sees only a `Candidate` and
 * never learns which origin produced it — which is the whole point of the
 * service.
 */
export interface Source {
  name: string;

  /** Absolute root of this origin's tree. */
  root(): string;

  /** Every file this origin holds that stocker knows how to interpret. */
  walk(): AsyncIterable<Candidate>;
}
