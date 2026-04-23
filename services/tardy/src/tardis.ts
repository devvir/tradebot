import type { TardyTable, WsMessage } from './types';

const TARDIS_BASE_URL = 'https://api.tardis.dev/v1/data-feeds/bitmex';
const MINUTES_PER_DAY = 1_440;

export interface TardisMessage {
  table: TardyTable;
  msg:   WsMessage;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Streams all messages for a given date from the Tardis API, yielding one
 * {table, msg} pair at a time. Fetches 1440 minute-buckets sequentially
 * using the offset param. No API key required (free tier).
 */
export async function* streamDate(date: string, tables: TardyTable[]): AsyncGenerator<TardisMessage> {
  const filter  = JSON.stringify(tables.map(t => ({ channel: t })));
  const isoDate = toIsoDate(date);

  for (let offset = 0; offset < MINUTES_PER_DAY; offset++) {
    const url = `${TARDIS_BASE_URL}?from=${isoDate}&offset=${offset}&filters=${encodeURIComponent(filter)}`;
    const res = await fetchWithRetry(url);

    yield* parseMinute(res, tables);
  }
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

  let parsed: { table?: unknown; action?: unknown; data?: unknown };

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
      action: parsed.action,
      date,
      data:   parsed.data as Record<string, unknown>[],
    },
  };
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
