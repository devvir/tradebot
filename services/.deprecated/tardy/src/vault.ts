import { logger } from '@devvir/service-kit';
import type { FetchClientHandle } from '@devvir/service-kit';
import type { FileState, TardyTable, WsMessage } from './types';

/**
 * Vault access for tardy. Retry against a recovering vault — uncapped, with
 * capped exponential backoff — and unreachable/recovered logging are handled
 * by the `vault` client (its `retryOn` covers 429/503/5xx; see service.ts).
 */

// ── URL helpers ───────────────────────────────────────────────────────────────

const withSuffix = (path: string, suffix: string): string =>
  suffix ? `${path}?suffix=${suffix}` : path;

// ── Queries ───────────────────────────────────────────────────────────────────

/** List the files vault holds for a table. 404 (table not yet created) → `{}`. */
export const listFiles = async (vault: FetchClientHandle, table: TardyTable, suffix: string): Promise<Record<string, FileState>> => {
  const files = await vault.get<Record<string, FileState>>(
    withSuffix(`/files/${table}`, suffix),
    { passThrough: [404] },
  );

  return files ?? {};
};

// ── Writes ────────────────────────────────────────────────────────────────────

export const writeRows = async (vault: FetchClientHandle, table: TardyTable, date: string, rows: WsMessage[], suffix: string): Promise<void> => {
  const res = await vault.request(withSuffix(`/files/${table}/${date}/rows`, suffix), {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(rows),
  });

  if (res.ok) return;

  // 409/418: the file is sealed — drop the batch, this date is already complete.
  logger.warn({ table, date, status: res.status }, 'Vault file sealed — dropping batch');
};

export const closeFile = async (vault: FetchClientHandle, table: TardyTable, date: string, suffix: string): Promise<void> => {
  await vault.request(withSuffix(`/files/${table}/${date}/close`, suffix), { method: 'POST' });
};

export const deleteFile = async (vault: FetchClientHandle, table: TardyTable, date: string, suffix: string): Promise<void> => {
  await vault.request(withSuffix(`/files/${table}/${date}`, suffix), { method: 'DELETE' });
};
