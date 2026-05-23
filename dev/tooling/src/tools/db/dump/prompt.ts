import inquirer from 'inquirer';
import { spacer } from '../../../shared/ui/logger';
import { C } from '../../../shared/utils/colors';
import { pairsExisting } from '../utils/existing';
import { pairFilename, pairKey } from '../types';
import type { Pair, ExistingStatus } from '../types';

// ── Exports ──────────────────────────────────────────────────────────────────

/**
 * Print a "Already exist" block and prompt whether to skip those pairs.
 * Returns the (possibly reduced) list of pairs to actually dump.
 */
export async function promptSkipExisting(
  pairs:    Pair[],
  existing: Map<string, ExistingStatus>,
): Promise<Pair[]> {
  const dupes = pairsExisting(pairs, existing);

  if (dupes.length === 0) return pairs;

  printExisting(dupes, existing);
  spacer();

  const answer = await inquirer.prompt([{
    type:    'confirm',
    name:    'skip',
    message: `Skip ${dupes.length} existing file${dupes.length === 1 ? '' : 's'}?`,
    default: true,
  }]);

  if (! answer.skip) return pairs;

  const skipKeys = new Set(dupes.map(pairKey));

  return pairs.filter(p => ! skipKeys.has(pairKey(p)));
}

// ── Internals ────────────────────────────────────────────────────────────────

function printExisting(pairs: Pair[], existing: Map<string, ExistingStatus>): void {
  console.log(`${C.bold}Already exist:${C.reset}`);

  for (const pair of pairs) {
    const status = existing.get(pairKey(pair))!;
    const where  = [status.local && 'local', status.mega && 'mega'].filter(Boolean).join(' + ');

    console.log(`  ${pair.collection}/${pairFilename(pair)}  ${C.dim}(${where})${C.reset}`);
  }
}
