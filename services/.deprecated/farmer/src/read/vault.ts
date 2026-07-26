/**
 * Vault HTTP client. Four calls:
 *
 *   - `listTables`, `listFiles`, `statFile` for discovery (retry on failure)
 *   - `streamBucket` for the NDJSON body of one closed file, with mid-stream
 *     recovery: if vault disappears partway through, we retry with
 *     `?skip = local position` so we resume from where we already got to —
 *     not from the Redis checkpoint (which lags) and not from zero.
 *
 * Large-skip reads (>1M rows) use a dedicated undici Agent with
 * `bodyTimeout: 0` because vault may pause for several minutes while
 * seeking server-side. Small reads keep the default so genuinely stuck
 * streams still fail loudly.
 *
 * `vaultDown` is a module-level flag shared by every call so we log
 * "unreachable" / "recovered" only on state transitions — never per retry.
 */

import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { Agent, fetch as undiciFetch } from 'undici';
import { logger } from '@devvir/service-kit';
import type { FileState } from '../types';

const RETRY_DELAY_MS   = 5_000;
const FETCH_TIMEOUT_MS = 15_000;

const noBodyTimeoutDispatcher = new Agent({ bodyTimeout: 0 });

// ── Public API ────────────────────────────────────────────────────────────────

export const listTables = async (vaultUrl: string): Promise<string[]> => {
  const res = await vaultFetch(`${vaultUrl}/tables`);

  return res.json() as Promise<string[]>;
};

export const listFiles = async (
  vaultUrl: string,
  table:    string,
): Promise<Record<string, FileState> | null> => {
  const res = await vaultFetch(`${vaultUrl}/files/${table}`);

  if (res.status === 404) return null;

  return res.json() as Promise<Record<string, FileState>>;
};

export interface FileStats {
  state:     FileState;
  size:      number;
  mtime:     number;
  birthtime: number;
}

export const statFile = async (
  vaultUrl: string,
  table:    string,
  date:     string,
): Promise<FileStats | null> => {
  const res = await vaultFetch(`${vaultUrl}/stats/${table}/${date}`);

  if (res.status === 404) return null;

  return res.json() as Promise<FileStats>;
};

/**
 * Stream one bucket's NDJSON body, calling `onLine(line, position)` for
 * every record vault yields. `position` is 1-based and absolute within
 * the bucket file. If `skip = N` the first yielded message is
 * `position = N + 1`.
 *
 * Recovers transparently from vault outages mid-stream: the local
 * `position` is preserved across retries, and each retry sends
 * `?skip = position` so we resume exactly past the last line we already
 * pushed downstream. The caller never sees the interruption — they just
 * see the same lines (and only the next lines) eventually arrive.
 *
 * Returns the total message count in the bucket (= the last position
 * observed). Throws only on permanent errors (404).
 */
export const streamBucket = async (
  vaultUrl: string,
  table:    string,
  date:     string,
  onLine:   (line: string, position: number) => Promise<void>,
  skip:     number = 0,
): Promise<number> => {
  let position = skip;

  while (true) {
    const url = position > 0
      ? `${vaultUrl}/files/${table}/${date}?skip=${position}`
      : `${vaultUrl}/files/${table}/${date}`;

    const controller = new AbortController();
    const timer      = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    let res: Response;

    try {
      /**
       * Any resume (`position > 0`) uses undici's own fetch+Agent pair with
       * no body timeout — vault may pause for seconds while it seeks to
       * the requested skip offset, and undici's default 5-minute body
       * timeout has tripped at moderate skip values (~900k lines) on
       * larger tables. Initial reads keep the default for liveness on
       * genuinely stuck streams. Userland Agent + Node's global fetch
       * isn't compatible because Node bundles a different undici major.
       */
      if (position > 0) {
        res = await undiciFetch(url, { signal: controller.signal, dispatcher: noBodyTimeoutDispatcher }) as unknown as Response;
      } else {
        res = await fetch(url, { signal: controller.signal });
      }
    } catch (err) {
      clearTimeout(timer);
      markVaultDown({ table, date, position, cause: describeError(err) },
        'Vault unreachable mid-stream — will resume from current position');
      await sleep(RETRY_DELAY_MS);
      continue;
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 404) {
      throw new Error(`Vault read failed for ${table}/${date}: HTTP 404`);
    }

    if (! res.ok) {
      markVaultDown({ table, date, position, status: res.status },
        'Vault HTTP error mid-stream — will resume from current position');
      await sleep(RETRY_DELAY_MS);
      continue;
    }

    markVaultUp();

    const lines = createInterface({
      input:     Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]),
      crlfDelay: Infinity,
    });

    try {
      for await (const line of lines) {
        position++;

        await onLine(line, position);
      }
    } catch (err) {
      markVaultDown({ table, date, position, cause: describeError(err) },
        'Vault stream broken — will resume from current position');
      await sleep(RETRY_DELAY_MS);
      continue;
    }

    logger.debug({ table, date, position, skip }, 'Finished reading vault file');

    return position;
  }
};

// ── Internals ─────────────────────────────────────────────────────────────────

/**
 * Shared down/up state. Both `vaultFetch` and `streamBucket` flip it on
 * the same transitions so the log says "unreachable" once and "recovered"
 * once, regardless of which call detected the change.
 */
let vaultDown = false;

const markVaultDown = (context: object, message: string): void => {
  if (vaultDown) return;

  vaultDown = true;
  logger.warn(context, message);
};

const markVaultUp = (): void => {
  if (! vaultDown) return;

  vaultDown = false;
  logger.info('Vault recovered');
};

const vaultFetch = async (url: string): Promise<Response> => {
  while (true) {
    try {
      const res = await fetch(url);

      if (res.ok || res.status === 404) {
        markVaultUp();

        return res;
      }

      markVaultDown({ url, status: res.status }, 'Vault HTTP error — retrying until it recovers');
    } catch (err) {
      markVaultDown({ url, cause: describeError(err) }, 'Vault unreachable — retrying until it recovers');
    }

    await sleep(RETRY_DELAY_MS);
  }
};

/**
 * Pulls the actually-useful bits out of a fetch/stream error: the cause
 * code (e.g. `ECONNREFUSED`, `ECONNRESET`, `UND_ERR_BODY_TIMEOUT`), the
 * top-level error name (e.g. `AbortError` for headers-timeout), and a
 * short message. Drops the giant undici/Node stack trace.
 */
const describeError = (err: unknown): string => {
  const e        = err as { name?: string; message?: string; cause?: { code?: string; errno?: string; message?: string } };
  const code     = e?.cause?.code  ?? e?.cause?.errno ?? null;
  const name     = e?.name && e.name !== 'Error' ? e.name : null;
  const message  = e?.message || e?.cause?.message || String(err);
  const tag      = code ?? name;

  return tag ? `${tag}: ${message}` : message;
};

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));
