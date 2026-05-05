import { logger } from '@devvir/service-kit';
import type { FileState, TardyTable, WsMessage } from './types';

// ── Retry config ──────────────────────────────────────────────────────────────
//
// Vault errors are all recoverable from tardy's perspective:
//   - 429        a single path is throttled by vault's per-file backpressure
//   - 503        vault storage is globally unhealthy (canary recovers it)
//   - network    vault is restarting, starting, or unreachable
//   - other 5xx  unexpected, treat the same as network — back off and retry
//
// Tardy has no useful work to do while vault is unavailable. Crashing would
// not fix any of these conditions and a restart loses in-memory buffers — so
// retries are uncapped, with capped exponential backoff to avoid hammering.

let initialDelayMs = 1_000;
let maxDelayMs     = 30_000;

// ── Core fetch ────────────────────────────────────────────────────────────────

/**
 * Fetches a vault URL, retrying indefinitely until either an OK response or
 * a `passThrough` status (an expected non-OK the caller handles as business
 * logic, e.g. 404 "not found", 409 "sealed"). Each call carries its own
 * backoff state, so a sustained throttle on one path does not slow down
 * subsequent calls to other paths.
 */
const vaultFetch = async (url: string, init?: RequestInit, passThrough: number[] = []): Promise<Response> => {
  let delay = initialDelayMs;

  const backoff = async (): Promise<void> => {
    await sleep(delay);
    delay = Math.min(delay * 2, maxDelayMs);
  };

  for (;;) {
    let res: Response;

    try {
      res = await fetch(url, init);
    } catch (err) {
      logger.warn({ url, nextDelayMs: delay, err: (err as Error).message }, 'Vault unreachable — backing off');
      await backoff();
      continue;
    }

    if (res.ok || passThrough.includes(res.status)) return res;

    if (res.status === 429) {
      logger.info({ url, nextDelayMs: delay }, 'Vault throttled this path — backing off');
    } else if (res.status === 503) {
      logger.warn({ url, nextDelayMs: delay }, 'Vault storage unhealthy — backing off');
    } else {
      logger.warn({ url, status: res.status, nextDelayMs: delay }, 'Vault request failed — backing off');
    }

    await backoff();
  }
};

// ── URL helpers ───────────────────────────────────────────────────────────────

const withSuffix = (url: string, suffix: string): string =>
  suffix ? `${url}?suffix=${suffix}` : url;

// ── Queries ───────────────────────────────────────────────────────────────────

export const listFiles = async (vaultUrl: string, table: TardyTable, suffix: string): Promise<Record<string, FileState>> => {
  const url = withSuffix(`${vaultUrl}/files/${table}`, suffix);
  const res = await vaultFetch(url, undefined, [404]);

  if (res.status === 404) return {};

  return res.json() as Promise<Record<string, FileState>>;
};

// ── Writes ────────────────────────────────────────────────────────────────────

export const writeRows = async (vaultUrl: string, table: TardyTable, date: string, rows: WsMessage[], suffix: string): Promise<void> => {
  const url = withSuffix(`${vaultUrl}/files/${table}/${date}/rows`, suffix);
  const res = await vaultFetch(
    url,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(rows) },
    [409, 418],
  );

  if (res.ok) return;

  // 409/418: file is sealed — drop the batch, this date is already complete.
  logger.warn({ table, date, status: res.status }, 'Vault file sealed — dropping batch');
};

export const closeFile = async (vaultUrl: string, table: TardyTable, date: string, suffix: string): Promise<void> => {
  const url = withSuffix(`${vaultUrl}/files/${table}/${date}/close`, suffix);
  await vaultFetch(url, { method: 'POST' }, [404]);
};

export const deleteFile = async (vaultUrl: string, table: TardyTable, date: string, suffix: string): Promise<void> => {
  const url = withSuffix(`${vaultUrl}/files/${table}/${date}`, suffix);
  await vaultFetch(url, { method: 'DELETE' }, [404]);
};

// ── Helpers ───────────────────────────────────────────────────────────────────

const sleep = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms));

// ── Test aliases (do not use outside of tests) ────────────────────────────────

export const _test_setDelays = (initial: number, max: number): void => {
  initialDelayMs = initial;
  maxDelayMs     = max;
};
