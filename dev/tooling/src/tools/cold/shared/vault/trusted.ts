import path from 'node:path';
import { ERRORS, errorsIn, LEDGER, stockedIn } from './ledger';
import { error } from '../../../../shared/ui/logger';
import type { ColdConfig } from '../../types';

/** Whether the vault's own account can be gone by; says why where it cannot. */
export const trusted = (config: ColdConfig): boolean => {
  const lost = errorsIn(config.vaultRoot);

  if (lost.length > 0) {
    error(`The vault reports ${lost.length} problem${lost.length === 1 ? '' : 's'} in ${path.join(config.vaultRoot, ERRORS)} — `
      + 'nothing of the vault is moved until that is understood and the file is gone');

    process.exitCode = 1;

    return false;
  }

  if (! stockedIn(config.vaultRoot)) {
    error(`No ${LEDGER} in ${config.vaultRoot} — the vault's ledger is what says what the vault holds. Is DATA_VAULT_DIR right?`);

    process.exitCode = 1;

    return false;
  }

  return true;
};
