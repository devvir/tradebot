import { streamRecords } from '../fs/reader';
import { applyCasts } from './casts';

/**
 * Decodes a closed vault file into a stream of NDJSON lines.
 *
 * WS files (first column is `_date_`) are reconstructed into message envelopes:
 *   { action, date, data: Row[] }
 *
 * REST files are emitted as plain row objects, one per line.
 *
 * `skip` skips the first N messages/items using a cheap heuristic:
 * for WS files, a record whose first field is empty is a continuation row
 * (not a new message), so only non-continuation records advance the skip
 * counter.
 */
export async function* decodeFile(
  table:    string,
  filename: string,
  skip = 0,
): AsyncGenerator<string> {
  const records = streamRecords(table, filename);
  const first   = await records.next();

  if (first.done) return;

  const cols  = first.value;
  const isWs  = cols[0] === '_date_';

  // For WS rows, columns 0 and 1 are metadata (_date_, _action_).
  // Data columns start at index 2.
  const dataCols = isWs ? cols.slice(2) : cols;

  // ── Skip state ──────────────────────────────────────────────────────────────
  //
  // msgsToSkip counts down as we cross message boundaries.
  // skippingCurrent stays true until we finish skipping the current message,
  // preventing its continuation rows from leaking into the output.

  let msgsToSkip      = skip;
  let skippingCurrent = msgsToSkip > 0;

  // ── WS accumulation state ───────────────────────────────────────────────────

  let groupDate   = '';
  let groupAction = '';
  let groupRows:  Record<string, unknown>[] = [];

  const emitGroup = (): string => {
    const out   = JSON.stringify({ action: groupAction, date: groupDate, data: groupRows }) + '\n';
    groupDate   = '';
    groupAction = '';
    groupRows   = [];
    return out;
  };

  for await (const record of records) {
    const isContinuation = isWs && record[0] === '';

    if (! isContinuation) {
      // Crossing into a new message — update skip state.
      if (msgsToSkip > 0) {
        msgsToSkip--;
        skippingCurrent = true;
      } else {
        // Emit any accumulated WS group before starting the next one.
        if (isWs && groupDate) yield emitGroup();

        skippingCurrent = false;
      }
    }

    if (skippingCurrent) continue;

    if (isWs) {
      if (! isContinuation) {
        groupDate   = record[0] ?? '';
        groupAction = record[1] ?? '';
        const row   = applyFields(record.slice(2), dataCols, table);

        if (Object.keys(row).length > 0) groupRows.push(row);
      } else {
        const row = applyFields(record.slice(2), dataCols, table);
        groupRows.push(row);
      }
    } else {
      yield JSON.stringify(applyFields(record, dataCols, table)) + '\n';
    }
  }

  if (isWs && groupDate) yield emitGroup();
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Zips parsed field values with their column names and applies casts. */
const applyFields = (
  fields:   string[],
  cols:     string[],
  table:    string,
): Record<string, unknown> => {
  const raw: Record<string, string> = {};

  for (let i = 0; i < cols.length; i++) {
    raw[cols[i]!] = fields[i] ?? '';
  }

  return applyCasts(raw, table);
};
