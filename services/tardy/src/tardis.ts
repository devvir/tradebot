import type { TardyTable, WsMessage } from './types';

const TARDIS_BASE_URL = 'https://api.tardis.dev/v1/data-feeds/bitmex';

export const MINUTES_PER_DAY = 1_440;

export interface TardisMessage {
  table: TardyTable;
  msg:   WsMessage;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Fetches a single minute-bucket from Tardis and yields one {table, msg} pair
 * at a time. The caller drives the offset loop so it can flush per-minute
 * boundaries — sparse tables (e.g. announcement) need the minute boundary to
 * land their rows in vault, since their own size threshold may never trigger.
 * No API key required (free tier).
 */
export async function* streamMinute(
  date:    string,
  offset:  number,
  tables:  TardyTable[],
): AsyncGenerator<TardisMessage> {
  const filter  = JSON.stringify(tables.map(t => ({ channel: t })));
  const isoDate = toIsoDate(date);
  const url     = `${TARDIS_BASE_URL}?from=${isoDate}&offset=${offset}&filters=${encodeURIComponent(filter)}`;
  const res     = await fetchWithRetry(url);

  yield* parseMinute(res, tables);
}

// ── Parsing ───────────────────────────────────────────────────────────────────

async function* parseMinute(res: Response, tables: TardyTable[]): AsyncGenerator<TardisMessage> {
  if (! res.body) return;

  const reader  = res.body.getReader();
  const decoder = new TextDecoder();
  let   carry   = '';

  for (;;) {
    const { done, value } = await reader.read();

    if (done) break;

    carry += decoder.decode(value, { stream: true });

    const lines = carry.split('\n');

    carry = lines.pop() ?? '';

    for (const line of lines) {
      const item = parseLine(line, tables);

      if (item) yield item;
    }
  }

  // Flush any remaining content after the stream ends.
  const remaining = carry + decoder.decode();

  if (remaining.trim()) {
    const item = parseLine(remaining, tables);

    if (item) yield item;
  }
}

/**
 * Parses a single Tardis line: `<ISO timestamp> <WS message JSON>`.
 * Returns null for blank lines, malformed lines, or tables not in the
 * requested set.
 */
const parseLine = (line: string, tables: TardyTable[]): TardisMessage | null => {
  const trimmed = line.trim();

  if (! trimmed) return null;

  const spaceIdx = trimmed.indexOf(' ');

  if (spaceIdx === -1) return null;

  const rawTs  = trimmed.slice(0, spaceIdx);
  const rawMsg = trimmed.slice(spaceIdx + 1);

  // Truncate nanosecond precision to milliseconds (3 decimal places).
  const date = rawTs.slice(0, 23) + 'Z';

  let parsed: { table?: unknown; action?: unknown; filter?: unknown; data?: unknown };

  try {
    parsed = JSON.parse(rawMsg) as typeof parsed;
  } catch {
    return null;
  }

  if (
    typeof parsed.table  !== 'string' ||
    typeof parsed.action !== 'string' ||
    ! Array.isArray(parsed.data)
  ) {
    return null;
  }

  const table = parsed.table as TardyTable;

  if (! tables.includes(table)) return null;

  return {
    table,
    msg: {
      action: encodeAction(parsed.action as string, parsed.filter),
      date,
      data:   parsed.data as Record<string, unknown>[],
    },
  };
};

/**
 * Encodes a symbol filter into the action string for partial messages, so it
 * survives vault storage and can be decoded by farmer on import.
 * e.g. action='partial' + filter={symbol:'XBTUSD'} → 'partial:XBTUSD'
 * Non-partial actions and partials without a symbol filter are returned as-is.
 */
const encodeAction = (action: string, filter: unknown): string => {
  if (action !== 'partial') return action;

  const symbol = filter && typeof filter === 'object'
    ? (filter as Record<string, unknown>).symbol
    : undefined;

  return typeof symbol === 'string' && symbol ? `partial:${symbol}` : action;
};

// ── HTTP ──────────────────────────────────────────────────────────────────────

const RETRY_BASE_MS = 1_000;
const MAX_RETRIES   = 8;

const fetchWithRetry = async (url: string): Promise<Response> => {
  let attempt = 0;

  for (;;) {
    try {
      const res = await fetch(url);

      if (res.ok) return res;

      // 429 is a transient rate-limit signal — fall through to the shared
      // backoff path so it honours MAX_RETRIES like network errors do.
      throw new Error(`Tardis HTTP ${res.status}`);
    } catch (err) {
      if (attempt >= MAX_RETRIES) throw err;

      const delay = RETRY_BASE_MS * Math.pow(2, attempt);

      await sleep(delay);
      attempt++;
    }
  }
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Converts YYYYMMDD to YYYY-MM-DD for the Tardis `from` param. */
const toIsoDate = (ymd: string): string =>
  `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;

const sleep = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms));

// ── Test exports ──────────────────────────────────────────────────────────────

export const _test_parseLine   = parseLine;
export const _test_parseMinute = parseMinute;
