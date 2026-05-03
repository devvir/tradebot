import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { Agent, fetch as undiciFetch } from 'undici';
import { logger } from '@devvir/service-kit';
import type { Row, WsMessage, FileState, VaultReadContext } from './types';

const RETRY_DELAY_MS       = 5_000;
const FETCH_TIMEOUT_MS     = 15_000;
const LARGE_SKIP_THRESHOLD = 1_000_000;

/**
 * Dispatcher used for large-skip reads where vault may pause for several
 * minutes between chunks while skipping past millions of rows server-side.
 * Disables undici's body inactivity timeout (default 300s) for those reads
 * only — small reads keep the default so genuinely stuck streams still fail.
 */
const noBodyTimeoutDispatcher = new Agent({ bodyTimeout: 0 });

/** Returns all tables that have data in vault. */
export const listTables = async (vaultUrl: string): Promise<string[]> => {
  const res = await vaultFetch(`${vaultUrl}/tables`);

  return res.json() as Promise<string[]>;
};

/** Returns all dates and their state for a table, or null if the table does not exist. */
export const listFiles = async (
  vaultUrl: string,
  table: string,
): Promise<Record<string, FileState> | null> => {
  const res = await vaultFetch(`${vaultUrl}/files/${table}`);

  if (res.status === 404) return null;

  return res.json() as Promise<Record<string, FileState>>;
};

/**
 * Streams a vault file (NDJSON) and calls onGroup for each entry,
 * starting from the entry at absolute index `startFrom` (default 0).
 *
 * When `startFrom > 0` we ask vault to skip the first `startFrom` rows
 * server-side via `?skip=N`, so the response stream begins at that absolute
 * index. Every received row is therefore live data — nothing is dropped
 * on this side.
 *
 * WS files:   each line is a WsMessage object `{ action, date, data }`.
 * REST files: each line is a plain Row object.
 *
 * Use `isWsMessage` to distinguish the two shapes in the callback.
 *
 * `msgIndex` is always the absolute index from the start of the file,
 * so it can be used directly as the new offset after publishing.
 *
 * Returns the total number of entries in the file (including skipped ones).
 */
export const readFileGroups = async (
  vaultUrl: string,
  table: string,
  date: string,
  onGroup: (item: WsMessage | Row, msgIndex: number) => Promise<void>,
  startFrom = 0,
): Promise<number> => {
  const url = startFrom > 0
    ? `${vaultUrl}/files/${table}/${date}?skip=${startFrom}`
    : `${vaultUrl}/files/${table}/${date}`;

  const ctx        = { table, date, startFrom };
  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let res: Response;

  try {
    /**
     * Large-skip reads use undici's own fetch+Agent pair so the custom dispatcher
     * is guaranteed compatible. Passing a userland Agent to Node's global fetch
     * fails because Node bundles a different undici major version.
     */
    if (startFrom > LARGE_SKIP_THRESHOLD) {
      res = await undiciFetch(url, { signal: controller.signal, dispatcher: noBodyTimeoutDispatcher }) as unknown as Response;
    } else {
      res = await fetch(url, { signal: controller.signal });
    }
  } catch (err) {
    throw mapFetchError(err, ctx);
  } finally {
    clearTimeout(timer);
  }

  if (! res.ok) throw new Error(`Vault read failed for ${table}/${date}: HTTP ${res.status}`);

  const lines = createInterface({
    input:      Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]),
    crlfDelay:  Infinity,
  });

  let groupIndex = startFrom;

  try {
    for await (const line of lines) {
      if (! line.trim()) continue;

      const item = JSON.parse(line) as WsMessage | Row;

      await onGroup(item, groupIndex);

      groupIndex++;
    }
  } catch (err) {
    throw mapFetchError(err, { ...ctx, msgIndex: groupIndex });
  }

  logger.debug({ table, date, groupIndex, startFrom }, 'Finished reading vault file');

  return groupIndex;
};

/**
 * Maps undici/fetch errors to a single-line Error that names the actual
 * timeout value, file, skip, and rows read so far. Replaces the default
 * TypeError stack (full of undici internals) with something useful in logs.
 */
const mapFetchError = (err: unknown, ctx: VaultReadContext): Error => {
  const cause       = (err as { cause?: { code?: string; message?: string; errno?: string } })?.cause;
  const code        = cause?.code;
  const causeMsg    = cause?.message;
  const causeErrno  = cause?.errno;
  const name        = (err as { name?: string })?.name;
  const outerMsg    = (err as Error)?.message || String(err);

  const skipPart = ctx.startFrom > 0 ? `, skip=${ctx.startFrom}` : '';
  const readPart = ctx.msgIndex !== undefined
    ? `, after ${ctx.msgIndex - ctx.startFrom} rows streamed`
    : '';

  if (code === 'UND_ERR_BODY_TIMEOUT') {
    return new Error(
      `Vault body timeout for ${ctx.table}/${ctx.date}${skipPart}${readPart} ` +
      `(bodyTimeout=${ctx.startFrom > LARGE_SKIP_THRESHOLD ? 'disabled' : 'undici default 300000ms'})`,
    );
  }

  if (code === 'UND_ERR_HEADERS_TIMEOUT' || name === 'AbortError') {
    return new Error(
      `Vault headers timeout for ${ctx.table}/${ctx.date}${skipPart} ` +
      `(headersTimeout=${FETCH_TIMEOUT_MS}ms)`,
    );
  }

  /** Fallback — surface every detail we have from the underlying cause so it's debuggable. */
  const causeParts = [code, causeErrno, causeMsg].filter(Boolean).join(' / ');
  const causeBlurb = causeParts ? ` (cause: ${causeParts})` : '';

  return new Error(
    `Vault read failed for ${ctx.table}/${ctx.date}${skipPart}${readPart}: ${outerMsg}${causeBlurb}`,
  );
};

const vaultFetch = async (url: string): Promise<Response> => {
  while (true) {
    try {
      const res = await fetch(url);

      if (res.ok || res.status === 404) return res;

      logger.warn({ url, status: res.status }, 'Vault HTTP error — retrying');
    } catch (err) {
      logger.warn({ url, err }, 'Vault unreachable — retrying');
    }

    await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
  }
};
