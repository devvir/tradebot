import { logger } from '@devvir/service-kit';
import type { Table } from './types';

const S3_BASE_URL    = 'https://s3-eu-west-1.amazonaws.com/public.bitmex.com/data';
const MAX_RETRIES    = 5;
const RETRY_BASE     = 1_000;
const VAULT_RETRY_MS = 5_000;

// ── Vault fetch ───────────────────────────────────────────────────────────────
//
// Retries indefinitely when vault is unreachable. Logs once on first failure
// and once on recovery — no repeated tracebacks.

let vaultDown = false;

const vaultFetch = async (url: string, init?: RequestInit): Promise<Response> => {
  for (;;) {
    try {
      const res = await fetch(url, init);

      if (vaultDown) {
        vaultDown = false;
        logger.info('Vault recovered');
      }

      return res;
    } catch (err) {
      if (! vaultDown) {
        vaultDown = true;
        logger.warn({ err: (err as Error).message }, 'Vault unreachable — waiting for it to recover');
      }

      await sleep(VAULT_RETRY_MS);
    }
  }
};

// ── Vault queries ─────────────────────────────────────────────────────────────

export const listVaultDates = async (vaultUrl: string, table: Table): Promise<string[]> => {
  const res = await vaultFetch(`${vaultUrl}/files/${table}`);

  if (! res.ok) throw new Error(`Vault list failed: HTTP ${res.status}`);

  const files = await res.json() as Record<string, string>;

  return Object.keys(files);
};

// ── S3 → vault streaming ──────────────────────────────────────────────────────
//
// Downloads a gzip from BitMEX S3 and streams the raw bytes directly to vault
// via a chunked PUT. No intermediate disk I/O — the response body is piped
// straight through.

export const fetchAndStore = async (vaultUrl: string, table: Table, date: string): Promise<void> => {
  const url     = `${S3_BASE_URL}/${table}/${date}.csv.gz`;
  let   attempt = 0;

  while (attempt < MAX_RETRIES) {
    try {
      logger.info({ table, date, attempt }, 'Downloading');

      const s3Res = await fetch(url);

      if (s3Res.status === 404) {
        logger.warn({ table, date }, 'File not found on S3 (404) — skipping');
        return;
      }

      if (! s3Res.ok) throw new Error(`S3 HTTP ${s3Res.status}`);

      if (! s3Res.body) throw new Error('S3 response has no body');

      const vaultRes = await vaultFetch(`${vaultUrl}/files/${table}/${date}`, {
        method: 'PUT',
        body:   s3Res.body,
        // Node.js undici requires duplex:'half' when streaming a request body
        duplex: 'half',
      } as RequestInit);

      if (vaultRes.status === 409) {
        logger.info({ table, date }, 'File already in vault — skipping');
        return;
      }

      if (! vaultRes.ok) throw new Error(`Vault PUT HTTP ${vaultRes.status}`);

      logger.info({ table, date }, 'Stored in vault');
      return;
    } catch (err) {
      attempt++;

      if (attempt >= MAX_RETRIES) throw err;

      const delay = RETRY_BASE * Math.pow(2, attempt);

      logger.warn({ err: (err as Error).message, table, date, attempt, delay }, 'S3 fetch failed — retrying');

      await sleep(delay);
    }
  }
};

// ── Helpers ───────────────────────────────────────────────────────────────────

const sleep = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms));
