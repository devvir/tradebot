import { logger } from '@devvir/service-kit';
import type { FileState, TardyTable, WsMessage } from './types';

const RETRY_DELAY_MS = 5_000;

const vaultFetch = async (url: string, init?: RequestInit): Promise<Response> => {
  for (;;) {
    try {
      return await fetch(url, init);
    } catch (err) {
      logger.warn({ url, err: (err as Error).message }, `Vault unreachable — retrying in ${RETRY_DELAY_MS / 1000}s`);
      await sleep(RETRY_DELAY_MS);
    }
  }
};

// ── Queries ───────────────────────────────────────────────────────────────────

export const listFiles = async (vaultUrl: string, table: TardyTable): Promise<Record<string, FileState>> => {
  const res = await vaultFetch(`${vaultUrl}/files/${table}`);

  if (res.status === 404) return {};
  if (! res.ok) throw new Error(`Vault list failed for ${table}: HTTP ${res.status}`);

  return res.json() as Promise<Record<string, FileState>>;
};

// ── Writes ────────────────────────────────────────────────────────────────────

export const writeRows = async (vaultUrl: string, table: TardyTable, date: string, rows: WsMessage[]): Promise<void> => {
  const res = await vaultFetch(`${vaultUrl}/files/${table}/${date}/rows`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(rows),
  });

  if (res.ok) return;

  // File sealed — drop the batch, this date is already complete from another source.
  if (res.status === 409 || res.status === 418) {
    logger.warn({ table, date, status: res.status }, 'Vault file sealed — dropping batch');
    return;
  }

  throw new Error(`Vault write failed for ${table}/${date}: HTTP ${res.status}`);
};

export const closeFile = async (vaultUrl: string, table: TardyTable, date: string): Promise<void> => {
  const res = await vaultFetch(`${vaultUrl}/files/${table}/${date}/close`, { method: 'POST' });

  if (res.ok || res.status === 404) return;

  throw new Error(`Vault close failed for ${table}/${date}: HTTP ${res.status}`);
};

export const deleteFile = async (vaultUrl: string, table: TardyTable, date: string): Promise<void> => {
  const res = await vaultFetch(`${vaultUrl}/files/${table}/${date}`, { method: 'DELETE' });

  if (res.ok || res.status === 404) return;

  throw new Error(`Vault delete failed for ${table}/${date}: HTTP ${res.status}`);
};

// ── Helpers ───────────────────────────────────────────────────────────────────

const sleep = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms));
