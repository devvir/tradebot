import fs from 'node:fs';
import path from 'node:path';
import { isDryRun } from '../../options';
import {
  reportDryRunTarget,
  reportGroupStart,
  reportSkippedAlready,
  reportSkippedInProgress,
  reportSources,
} from './report';
import type { PrepareGroup, PreflightDecision } from '../types';

/**
 * Decide whether a group should be processed and announce the decision.
 * Returns a discriminated decision the caller switches on.
 */
export function preflight(group: PrepareGroup): PreflightDecision {
  reportGroupStart(group);

  const finalPath = path.join(group.outputDir, group.outputName);
  const tmpPath   = `${finalPath}.tmp`;

  if (fs.existsSync(finalPath)) {
    reportSkippedAlready(finalPath);

    return { outcome: 'skipped' };
  }

  if (fs.existsSync(tmpPath)) {
    reportSkippedInProgress(tmpPath);

    return { outcome: 'skipped' };
  }

  reportSources(group);

  if (isDryRun()) reportDryRunTarget(finalPath);

  const inputBytes = group.paths.reduce((sum, p) => sum + fs.statSync(p).size, 0);

  return { proceed: { tmpPath, finalPath, inputBytes } };
}
