import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { logger } from '@devvir/service-kit';

/** A row as returned by vault — values are already typed. */
export type Row = Record<string, unknown>;

/** A WS message as stored and returned by vault. */
export type WsMessage = {
  action: string;
  date:   string;
  data:   Row[];
};

/** Returns true if the parsed line is a WS message object. */
export const isWsMessage = (item: unknown): item is WsMessage =>
  typeof item === 'object' &&
  item !== null &&
  ! Array.isArray(item) &&
  'action' in item &&
  'date'   in item &&
  'data'   in item &&
  Array.isArray((item as WsMessage).data);

type FileState = 'open' | 'closed';

const RETRY_DELAY_MS = 5_000;

// When skip=0 vault starts emitting immediately; 15 s is ample for headers.
// When skip>0 vault must walk the file before the first byte arrives —
// 10 GB orderBookL2 files can take well over a minute to walk to row 5M+.
const FETCH_TIMEOUT_MS      = 15_000;
const FETCH_TIMEOUT_SKIP_MS = 300_000;

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

  const timeout = startFrom > 0 ? FETCH_TIMEOUT_SKIP_MS : FETCH_TIMEOUT_MS;
  const res     = await fetch(url, { signal: AbortSignal.timeout(timeout) });

  if (! res.ok) throw new Error(`Vault read failed for ${table}/${date}: HTTP ${res.status}`);

  const lines = createInterface({
    input:      Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]),
    crlfDelay:  Infinity,
  });

  let groupIndex = startFrom;

  for await (const line of lines) {
    if (! line.trim()) continue;

    const item = JSON.parse(line) as WsMessage | Row;

    await onGroup(item, groupIndex);

    groupIndex++;
  }

  logger.debug({ table, date, groupIndex, startFrom }, 'Finished reading vault file');

  return groupIndex;
};

