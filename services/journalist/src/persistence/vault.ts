import { logger } from '@devvir/service-kit';
import type { BitmexTable } from '../types';

const RECOVERY_PAUSE_MS = 5_000;

// Shared gate: when vault is down all concurrent callers wait on the same
// promise, resuming in arrival order once vault recovers.
let recoveryGate: Promise<void> | null = null;

// Tracks whether vault is currently unreachable so we only log once on each
// state transition rather than on every retry attempt.
let vaultDown = false;

export const waitForVault = (): Promise<void> => {
  if (recoveryGate === null) {
    recoveryGate = new Promise<void>((r) => setTimeout(r, RECOVERY_PAUSE_MS))
      .then(() => { recoveryGate = null; });
  }

  return recoveryGate;
};

export const writeToVault = async (
  vaultUrl: string,
  table:    BitmexTable,
  date:     string,
  rows:     unknown[],
  suffix:   string,
): Promise<boolean> => {
  try {
    const res = await fetch(withSuffix(`${vaultUrl}/files/${table}/${date}/rows`, suffix), {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(rows),
    });

    if (res.ok) {
      if (vaultDown) {
        vaultDown = false;
        logger.info({ table }, 'Vault recovered');
      }

      return true;
    }

    // 409 = file is being gzipped right now; 418 = already sealed.
    // Either way the file will never accept new rows — drop them rather
    // than retrying forever against a permanent condition.
    if (res.status === 409 || res.status === 418) {
      logger.warn({ table, date, status: res.status, batches: rows.length }, 'Vault file closed — dropping rows');
      return true;
    }

    if (! vaultDown) {
      vaultDown = true;
      const body = await res.text().catch(() => '');

      if (res.status === 429) {
        logger.info({ table, date, body }, 'Vault throttled this path — buffering until it clears');
      } else if (res.status === 503) {
        logger.warn({ table, date, body }, 'Vault storage unhealthy — buffering until it recovers');
      } else {
        logger.warn({ table, date, status: res.status, body }, 'Vault write failed — buffering until it recovers');
      }
    }
  } catch (err) {
    if (! vaultDown) {
      vaultDown = true;
      logger.warn({ table, date }, 'Vault unreachable — buffering messages until it recovers');
    }
  }

  return false;
};

export const closeVaultFile = async (
  vaultUrl: string,
  table:    BitmexTable,
  date:     string,
  suffix:   string,
): Promise<void> => {
  while (true) {
    try {
      const res = await fetch(withSuffix(`${vaultUrl}/files/${table}/${date}/close`, suffix), { method: 'POST' });

      if (res.ok || res.status === 404) return;

      logger.warn({ table, date, status: res.status }, 'Failed to close vault file — retrying');
    } catch {
      logger.warn({ table, date }, 'Vault unreachable during close — retrying');
    }

    await waitForVault();
  }
};

const withSuffix = (url: string, suffix: string): string =>
  suffix ? `${url}?suffix=${suffix}` : url;
