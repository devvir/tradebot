import { logger } from '@devvir/service-kit';
import type { FileState, TardyTable, WsMessage } from './types';

// ── Retry config ──────────────────────────────────────────────────────────────

const MAX_RETRIES   = 10;
const INITIAL_DELAY = 1_000;
const MAX_DELAY     = 30_000;

let retryCount   = 0;
let currentDelay = INITIAL_DELAY;

const resetRetry = (): void => {
  retryCount   = 0;
  currentDelay = INITIAL_DELAY;
};

const advanceBackoff = (): void => {
  currentDelay = Math.min(currentDelay * 2, MAX_DELAY);
};

// ── Core fetch ────────────────────────────────────────────────────────────────

/**
 * Fetches a vault URL with retry and exponential backoff.
 * Pass-through statuses are returned immediately without retrying — they are
 * expected non-ok codes (e.g. 404 "not found", 409 "sealed") that the caller
 * handles as normal business logic, not failures.
 * Resets retry state on every success. Throws after MAX_RETRIES failures.
 */
const vaultFetch = async (url: string, init?: RequestInit, passThrough: number[] = []): Promise<Response> => {
  for (;;) {
    try {
      const res = await fetch(url, init);

      if (res.ok || passThrough.includes(res.status)) {
        resetRetry();
        return res;
      }

      throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      retryCount++;

      if (retryCount >= MAX_RETRIES) {
        logger.fatal({ url, retries: retryCount, err: (err as Error).message }, 'Vault: max retries exhausted — shutting down');
        throw new Error(`Vault max retries exhausted after ${retryCount} attempts on ${url}: ${(err as Error).message}`);
      }

      logger.warn({ url, retry: retryCount, nextDelayMs: currentDelay, err: (err as Error).message }, 'Vault request failed — retrying');

      await sleep(currentDelay);
      advanceBackoff();
    }
  }
};

// ── Queries ───────────────────────────────────────────────────────────────────

export const listFiles = async (vaultUrl: string, table: TardyTable): Promise<Record<string, FileState>> => {
  const res = await vaultFetch(`${vaultUrl}/files/${table}`, undefined, [404]);

  if (res.status === 404) return {};

  return res.json() as Promise<Record<string, FileState>>;
};

// ── Writes ────────────────────────────────────────────────────────────────────

export const writeRows = async (vaultUrl: string, table: TardyTable, date: string, rows: WsMessage[]): Promise<void> => {
  const res = await vaultFetch(
    `${vaultUrl}/files/${table}/${date}/rows`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(rows) },
    [409, 418],
  );

  if (res.ok) return;

  // 409/418: file is sealed — drop the batch, this date is already complete.
  logger.warn({ table, date, status: res.status }, 'Vault file sealed — dropping batch');
};

export const closeFile = async (vaultUrl: string, table: TardyTable, date: string): Promise<void> => {
  await vaultFetch(`${vaultUrl}/files/${table}/${date}/close`, { method: 'POST' }, [404]);
};

export const deleteFile = async (vaultUrl: string, table: TardyTable, date: string): Promise<void> => {
  await vaultFetch(`${vaultUrl}/files/${table}/${date}`, { method: 'DELETE' }, [404]);
};

// ── Helpers ───────────────────────────────────────────────────────────────────

const sleep = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms));

// ── Test aliases (do not use outside of tests) ────────────────────────────────

export const _test_resetRetry = (): void => {
  retryCount   = 0;
  currentDelay = 0; // keep delays instant so tests don't block
};
