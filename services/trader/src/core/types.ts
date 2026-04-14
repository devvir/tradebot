/**
 * Core module types
 */

import type { DataDependency } from '../types';

export interface StrategyConfig {
  name:            string;
  symbol:          string;
  dependencies:    DataDependency[];
  tickIntervalMs:  number;
  /** Absolute price delta below which no amend is issued. Default: 0 (amend on any change). */
  amendThreshold?: number;
}
