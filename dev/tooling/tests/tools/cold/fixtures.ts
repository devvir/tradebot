import path from 'node:path';
import type { ColdConfig } from '../../../src/tools/cold/types';

/**
 * A whole configuration with every local path under `dir`, and Mega's paths
 * under `/x`, which no test reaches. `over` sets what a test needs otherwise.
 */
export const coldConfigFor = (dir: string, over: Partial<ColdConfig> = {}): ColdConfig => ({
  sourceRoot:    path.join(dir, 'archives'),
  vaultRoot:     path.join(dir, 'vault'),
  coldRoot:      path.join(dir, 'cold'),
  megaRoot:      '/x',
  backupRoot:    '/x/@cold',
  catalogDb:     path.join(dir, 'catalog', 'catalog.db'),
  catalogRoot:   '/x/@cold/catalog',
  dbPath:        path.join(dir, 'cold.sqlite'),
  capBytes:      1e12,
  queueTargetGb: 10,
  settledHours:  null,
  catalogUrl:    'http://catalog.test',
  catalogUnknown: null,
  catalogToken:  't',
  ...over,
});
