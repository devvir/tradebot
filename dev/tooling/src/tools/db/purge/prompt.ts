import inquirer from 'inquirer';
import { spacer, warn } from '../../../shared/ui/logger';
import { C } from '../../../shared/utils/colors';
import { pairsNotOnMega } from '../utils/existing';
import { pairFilename, pairKey } from '../types';
import type { Pair, ExistingStatus } from '../types';

// ── Exports ──────────────────────────────────────────────────────────────────

/**
 * Show pairs that are NOT backed up on Mega and offer to skip them.
 * Returns the (possibly reduced) list of pairs the user wants to purge.
 *
 * If the user declines to skip, the original list is returned — they're
 * choosing to delete data that has no off-site copy. A second guard prompt
 * in the caller catches that.
 */
export async function promptSkipUnbacked(
  pairs:    Pair[],
  existing: Map<string, ExistingStatus>,
): Promise<{ pairs: Pair[]; skippedUnbacked: boolean }> {
  const unbacked = pairsNotOnMega(pairs, existing);

  if (unbacked.length === 0) return { pairs, skippedUnbacked: false };

  printUnbacked(unbacked);
  spacer();

  const answer = await inquirer.prompt([{
    type:    'confirm',
    name:    'skip',
    message: `Skip ${unbacked.length} unbacked-up pair${unbacked.length === 1 ? '' : 's'}?`,
    default: true,
  }]);

  if (! answer.skip) return { pairs, skippedUnbacked: false };

  const skipKeys = new Set(unbacked.map(pairKey));

  return {
    pairs:           pairs.filter(p => ! skipKeys.has(pairKey(p))),
    skippedUnbacked: true,
  };
}

/** Final destructive-action confirm. Defaults to NO. */
export async function confirmPurge(pairCount: number): Promise<boolean> {
  const answer = await inquirer.prompt([{
    type:    'confirm',
    name:    'proceed',
    message: `${C.red}PERMANENTLY DELETE${C.reset} ${pairCount} pair${pairCount === 1 ? '' : 's'} from MongoDB?`,
    default: false,
  }]);

  return answer.proceed as boolean;
}

/** Extra-guard prompt when proceeding with pairs that have no Mega backup. */
export async function confirmDeleteUnbacked(count: number): Promise<boolean> {
  warn(`${count} pair${count === 1 ? ' has' : 's have'} no Mega backup — deleting them is irreversible.`);

  const answer = await inquirer.prompt([{
    type:    'confirm',
    name:    'proceed',
    message: `Really delete unbacked-up data?`,
    default: false,
  }]);

  return answer.proceed as boolean;
}

// ── Internals ────────────────────────────────────────────────────────────────

function printUnbacked(pairs: Pair[]): void {
  console.log(`${C.bold}${C.yellow}Not backed up on Mega:${C.reset}`);

  for (const pair of pairs) {
    console.log(`  ${pair.collection}/${pairFilename(pair)}`);
  }
}
