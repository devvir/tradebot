import { logger } from '@devvir/service-kit';
import type { FetchClientHandle, FetchInit } from '@devvir/service-kit';
import type { Table } from './types';

const S3_BASE_URL = 'https://s3-eu-west-1.amazonaws.com/public.bitmex.com/data';
const MAX_RETRIES = 5;
const RETRY_BASE  = 1_000;

// ── Vault queries ─────────────────────────────────────────────────────────────

/**
 * List the dates already stored in vault for a table. Retry against a
 * recovering vault, and unreachable/recovered logging, are handled by the
 * `vault` client.
 */
export const listVaultDates = async (vault: FetchClientHandle, table: Table): Promise<string[]> => {
  const files = await vault.get<Record<string, string>>(`/files/${table}`);

  return Object.keys(files ?? {});
};

// ── S3 → vault streaming ──────────────────────────────────────────────────────

/**
 * Download one day's gzip from BitMEX S3 and stream the raw bytes straight to
 * vault via a chunked PUT — no intermediate disk I/O.
 *
 * The S3 fetch and the vault PUT are retried together, with capped exponential
 * backoff: the request body is a one-shot stream, so a failed PUT must re-fetch
 * S3 for a fresh stream rather than replay a consumed one. The PUT therefore
 * runs with the client's own retry disabled — this loop owns it.
 */
export const fetchAndStore = async (vault: FetchClientHandle, table: Table, date: string): Promise<boolean> => {
  const url = `${S3_BASE_URL}/${table}/${date}.csv.gz`;

  let attempt = 0;

  while (attempt < MAX_RETRIES) {
    try {
      logger.info({ table, date, attempt }, 'Downloading');

      const s3Res = await fetch(url);

      if (s3Res.status === 404) {
        logger.info({ table, date }, 'File not yet published on S3 (404)');

        return false;
      }

      if (! s3Res.ok)   throw new Error(`S3 HTTP ${s3Res.status}`);
      if (! s3Res.body) throw new Error('S3 response has no body');

      const vaultRes = await vault.request(`/files/${table}/${date}`, {
        method: 'PUT',
        body:   s3Res.body,
        duplex: 'half',
        retry:  { attempts: 1 },   // this loop re-fetches S3 for a fresh stream — no client retry
      } as FetchInit);

      if (vaultRes.status === 409) {
        logger.info({ table, date }, 'File already in vault — skipping');

        return true;
      }

      if (! vaultRes.ok) throw new Error(`Vault PUT HTTP ${vaultRes.status}`);

      logger.info({ table, date }, 'Stored in vault');

      return true;
    } catch (err) {
      attempt++;

      if (attempt >= MAX_RETRIES) throw err;

      const delay = RETRY_BASE * Math.pow(2, attempt);

      logger.warn({ err: (err as Error).message, table, date, attempt, delay }, 'Download/store failed — retrying');

      await sleep(delay);
    }
  }

  throw new Error('unreachable');
};

// ── Helpers ───────────────────────────────────────────────────────────────────

const sleep = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms));
