import { WS_TABLES } from '@tradebot/utils';
import { createParser } from './parse';
import { applyCasts } from './casts';

/**
 * Decodes a closed vault file into a stream of NDJSON lines.
 *
 * WS tables are reconstructed into message envelopes:
 *   { action, date, data: Row[] }
 *
 * REST tables are emitted as plain row objects, one per line.
 *
 * `skip` drops the first N messages. Skipping — and the parsing strategy
 * behind it — is owned by the parser; see data/parse.ts.
 */
export async function* decodeFile(
  table:    string,
  filename: string,
  skip = 0,
): AsyncGenerator<string> {
  const records = createParser(table).read(filename, skip);
  const first   = await records.next();

  if (first.done) return;

  const cols = first.value;

  // REST files emit one plain row object per record.
  if (! WS_TABLES.has(table)) {
    for await (const record of records) {
      yield JSON.stringify(applyFields(record, cols, table)) + '\n';
    }

    return;
  }

  // WS rows carry two metadata columns (_date_, _action_); data starts at 2.
  const dataCols = cols.slice(2);

  // ── Message accumulation ────────────────────────────────────────────────────
  //
  // A record with a non-empty `_date_` opens a message; records with an empty
  // `_date_` are continuation rows that extend the message in flight.

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
    const row = applyFields(record.slice(2), dataCols, table);

    if (record[0] === '') {
      groupRows.push(row);
      continue;
    }

    if (groupDate) yield emitGroup();

    groupDate   = record[0] ?? '';
    groupAction = record[1] ?? '';

    if (Object.keys(row).length > 0) groupRows.push(row);
  }

  if (groupDate) yield emitGroup();
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Zips parsed field values with their column names and applies casts. */
const applyFields = (
  fields: string[],
  cols:   string[],
  table:  string,
): Record<string, unknown> => {
  const raw: Record<string, string> = {};

  for (let i = 0; i < cols.length; i++) {
    raw[cols[i]!] = fields[i] ?? '';
  }

  return applyCasts(raw, table);
};
