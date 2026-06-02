/**
 * Pops WS items from the assembler queue, replaces each item's raw vault
 * line with the fully-decorated wire envelope (kept as a string), and
 * pushes the result onto the writer queue.
 *
 * String-mode is the hot path: brace-count for the row count + drop on
 * empty data, regex-extract action/date/timestamp/data slice, splice
 * into the per-table template from `./templates`. No JSON.parse. No
 * JSON.stringify. No intermediate POJOs. The wire body that the flusher
 * eventually POSTs is built directly from these strings.
 *
 * Two rare cases fall back to the parse path (parse → existing
 * `reconstruct()` → JSON.stringify), because adding their per-message
 * variability to the templates would cost more than it'd save:
 *
 *   - `action.startsWith('partial:')` — symbol-qualified partial; filter
 *     becomes `{symbol: <SYMBOL>}` and varies per message
 *   - legacy `orderBookL2` buckets (`date < '20230101'`) — pre-2023 rows
 *     are missing `timestamp`/`transactTime`/`pool` and need per-row
 *     backfill
 *
 * Outcomes per item (string and parse paths both produce these):
 *
 *   - **empty `data` array (rows = 0)** — drop. Replay can synthesize
 *     these, storing them is wasted space.
 *   - **success** — mutate the item in place (`content` becomes the
 *     wire envelope, `rows` is set), admit to the staging gate, push
 *     onto the writer queue.
 *   - **structural error or parse throw on the fallback path** — write
 *     the original content to `farmer.<table>` for forensics, bump the
 *     task's progress, continue.
 *   - **`UnknownTableError`** (parse fallback only) — config drift
 *     between vault and `TABLE_SPECS`; trigger service shutdown.
 */

import { logger, registry } from '@devvir/service-kit';
import type { BitmexTable } from '@tradebot/types';
import { recordError } from '../write/errors';
import { admit } from '../write/staging';
import { reconstruct, UnknownTableError, type WsMessage } from './reconstruct';
import { templateFor } from './templates';
import type { BoundedBuffer, Item } from '../types';

const BATCH_MAX = 50_000;

const ACTION_PREFIX     = '"action":"';
const DATE_PREFIX       = '"date":"';
const DATA_PREFIX       = '"data":[';
const EMPTY_DATA_SUFFIX = '"data":[]}';
const TIMESTAMP_RX      = /"timestamp":"([^"]+)"/;

const ORDERBOOK_LEGACY_CUTOFF = '20230101';

const TIMESTAMP_TABLES = new Set<BitmexTable>(['orderBookL2', 'instrument']);

// ── Public API ────────────────────────────────────────────────────────────────

export const startAssemble = async (
  assemblerQueue: BoundedBuffer<Item>,
  writerQueue:    BoundedBuffer<Item>,
): Promise<void> => {
  while (true) {
    const items = await assemblerQueue.pop(BATCH_MAX);

    if (! items) return;

    for (const item of items) {
      const ok = await assembleOne(item);

      if (! ok) {
        if (item.task.stopSignal.triggered) return;
        continue;
      }

      await admit(item.size);
      item.task.admit();
      await writerQueue.push(item);
    }
  }
};

// ── Internals ─────────────────────────────────────────────────────────────────

/**
 * Mutates `item.content` (and `item.size`) into the wire envelope.
 * Returns `false` when the item should be dropped (empty data, parse
 * failure recorded to forensics, or shutdown triggered). Returns `true`
 * when the item is ready for the writer queue.
 */
const assembleOne = async (item: Item): Promise<boolean> => {
  const table   = item.task.table;
  const date    = item.task.date;
  const content = item.content;

  /** Empty-data envelopes carry no state — vault's deterministic output
   *  always closes them with `"data":[]}`, so a single suffix compare
   *  catches them with no full-content scan. */
  if (content.endsWith(EMPTY_DATA_SUFFIX)) {
    item.task.noteDisposed(item.position, false);
    return false;
  }

  const action = extractAction(content);

  if (! action) {
    return await forensics(item, 'malformed: no action field');
  }

  /** Two rare paths fall back to parse → existing reconstruct → stringify. */
  const needsParse =
    action.startsWith('partial:') ||
    (table === 'orderBookL2' && date < ORDERBOOK_LEGACY_CUTOFF);

  if (needsParse) return parseFallback(item);

  /** Common case: string template. */
  const messageDate = extractDate(content);

  if (! messageDate) {
    return await forensics(item, 'malformed: no date field');
  }

  const dataSlice = extractDataSlice(content);

  if (dataSlice === null) {
    return await forensics(item, 'malformed: no data array');
  }

  const timestamp = TIMESTAMP_TABLES.has(table)
    ? (extractFirstRowTimestamp(dataSlice) ?? messageDate)
    : messageDate;

  let template;

  try {
    template = templateFor(table);
  } catch (err) {
    if (err instanceof UnknownTableError) {
      await registry.get('farmer').shutdown(err.message);
      item.task.stopSignal.triggered = true;
      return false;
    }
    throw err;
  }

  item.content = action === 'partial'
    ? template.partial(timestamp, dataSlice)
    : template.simple(action, timestamp, dataSlice);
  item.size    = item.content.length;

  return true;
};

/** Parse-path fallback for the two rare cases. Uses the existing reconstruct()
 *  to handle per-message variation (partial-with-symbol filter, legacy row
 *  backfill). Output is JSON.stringify'd and re-enters the common pipeline. */
const parseFallback = async (item: Item): Promise<boolean> => {
  let parsed: WsMessage;

  try {
    parsed = JSON.parse(item.content) as WsMessage;
  } catch (err) {
    logger.warn({ err, table: item.task.table, position: item.position }, 'JSON.parse failed — preserving raw');
    return await forensics(item, 'parse failed');
  }

  let recon;

  try {
    recon = reconstruct(item.task.table, parsed);
  } catch (err) {
    if (err instanceof UnknownTableError) {
      await registry.get('farmer').shutdown(err.message);
      item.task.stopSignal.triggered = true;
      return false;
    }

    logger.warn({ err, table: item.task.table, position: item.position }, 'Reconstruct failed — preserving raw');
    return await forensics(item, 'reconstruct failed');
  }

  if (recon === null) {
    /** Defensive — the empty-data suffix check should already have ruled this out. */
    item.task.noteDisposed(item.position, false);
    return false;
  }

  item.content = JSON.stringify(recon);
  item.size    = item.content.length;

  return true;
};

const forensics = async (item: Item, reason: string): Promise<boolean> => {
  await recordError(item.task.table, item.task.date, item.position, item.content);
  logger.warn({ table: item.task.table, position: item.position, reason }, 'Assemble dropped item to forensics');

  item.task.noteDisposed(item.position, false);
  return false;
};

const extractAction = (content: string): string | null => {
  const start = content.indexOf(ACTION_PREFIX);

  if (start === -1) return null;

  const valueStart = start + ACTION_PREFIX.length;
  const valueEnd   = content.indexOf('"', valueStart);

  if (valueEnd === -1) return null;

  return content.slice(valueStart, valueEnd);
};

const extractDate = (content: string): string | null => {
  const start = content.indexOf(DATE_PREFIX);

  if (start === -1) return null;

  const valueStart = start + DATE_PREFIX.length;
  const valueEnd   = content.indexOf('"', valueStart);

  if (valueEnd === -1) return null;

  return content.slice(valueStart, valueEnd);
};

/**
 * Returns the slice between `[` and the matching final `]` of the
 * `data` array. Vault always emits `data` as the last field of the
 * envelope, closed by `]}`, so this is a single `indexOf` + endpoint
 * arithmetic — no bracket-counting needed.
 */
const extractDataSlice = (content: string): string | null => {
  const start = content.indexOf(DATA_PREFIX);

  if (start === -1) return null;

  const arrayStart = start + DATA_PREFIX.length;
  const end        = content.length - 2;   /** trailing `]}` */

  if (end <= arrayStart) return '';

  return content.slice(arrayStart, end);
};

/**
 * First-row timestamp scan. Only called for tables that we know carry a
 * `timestamp` field with no free-form strings around it (orderBookL2,
 * instrument). For other WS tables (chat, announcement,
 * publicNotifications) the caller falls back to the envelope date
 * directly to avoid false positives from match against free text.
 *
 * `dataSlice` looks like `{...row1...},{...row2...},...`. Bounding the
 * regex scope to the first row only ensures we never reach later rows
 * even though regex is greedy by default — the first `"timestamp":"..."`
 * we see is the answer.
 */
const extractFirstRowTimestamp = (dataSlice: string): string | null => {
  const match = TIMESTAMP_RX.exec(dataSlice);

  return match ? match[1]! : null;
};

// ── Test-only exports ─────────────────────────────────────────────────────────

export const _test_EMPTY_DATA_SUFFIX        = EMPTY_DATA_SUFFIX;
export const _test_extractAction            = extractAction;
export const _test_extractDate              = extractDate;
export const _test_extractDataSlice         = extractDataSlice;
export const _test_extractFirstRowTimestamp = extractFirstRowTimestamp;
export const _test_ORDERBOOK_LEGACY_CUTOFF  = ORDERBOOK_LEGACY_CUTOFF;
