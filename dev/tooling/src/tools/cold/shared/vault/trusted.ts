import path from 'node:path';
import { ERRORS, errorsIn, LEDGER, stockedIn } from './ledger';
import { error, info } from '../../../../shared/ui/logger';
import type { ColdConfig } from '../../types';
import type { Stocked } from '../types';

/** Whether the vault's own account can be gone by: what its ledger says it holds, where it can; where it cannot, whether to look again later. */
export type Trust = { ok: true; stocked: Stocked[] } | { ok: false; retry: boolean };

/**
 * Whether the vault's own account can be gone by; says why where it cannot.
 *
 * It cannot while the vault reports a problem (`ERROR.log`), or where there is
 * no ledger to read. Either fails the command — unless it is `watching`: then
 * it is a refusal to look again after, and the exit code is left alone. The
 * file is somebody's to deal with, and nothing goes by the vault's account
 * until they have.
 */
export const trusted = (config: ColdConfig, { watching = false }: { watching?: boolean } = {}): Trust => {
  const refused = (): Trust => {
    if (! watching) process.exitCode = 1;

    return { ok: false, retry: watching };
  };

  const lost = errorsIn(config.vaultRoot);

  if (lost.length > 0) {
    error(`The vault reports ${lost.length} problem${lost.length === 1 ? '' : 's'} in ${path.join(config.vaultRoot, ERRORS)} — `
      + 'nothing that goes by the vault\'s account is moved until that is understood and the file is gone');

    for (const line of lost.slice(0, 5)) info(`  ${line}`);

    return refused();
  }

  const stocked = stockedIn(config.vaultRoot);

  if (! stocked) {
    error(`No ${LEDGER} in ${config.vaultRoot} — the vault's ledger is what says what the vault holds. Is DATA_VAULT_DIR right?`);

    return refused();
  }

  return { ok: true, stocked };
};
