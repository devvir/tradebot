import type { FileCheck, MessageCheck } from './types';

/**
 * Pre-pass check: is the first line a header row?
 *
 * The only signal we need: does the line start with `_date_,`?
 * If yes — it's a header, parse columns from it.
 * If no (or file is empty) — emit `missing-header`; the orchestrator falls
 * back to vault's canonical TABLE_HEADERS for the table.
 */
export const headerCheck: FileCheck = {
  kind: 'file',
  name: 'header',

  run(firstLine, _ctx) {
    if (firstLine === null || ! firstLine.startsWith('_date_,')) {
      return {
        issues: [{
          type:    'missing-header',
          message: firstLine === null ? 'file is empty' : 'header row is missing — first line is data',
          date:    '',
        }],
        recoveredHeader: null,
      };
    }

    const columns = firstLine.split(',').map(c => c.trim());

    return {
      issues:          [],
      recoveredHeader: { columns, hasTimestamp: columns.includes('timestamp') },
    };
  },
};

/**
 * Streaming check: flag rows that look like a stray header embedded mid-stream.
 *
 * A mid-stream header indicates a concatenated file. We detect it by checking
 * whether the message-start row's field values equal the column names (the
 * only way a non-empty `_date_` can literally read `_date_` is if someone
 * glued two CSVs together).
 */
export const midStreamHeaderCheck: MessageCheck = {
  kind: 'message',
  name: 'mid-stream-header',

  onMessage(msg) {
    const firstRow = msg.rows[0];

    if (firstRow && looksLikeHeaderRecord(firstRow)) {
      return [{
        type:    'header-in-wrong-row',
        message: 'header-looking row found mid-stream',
        date:    msg.date,
      }];
    }

    return [];
  },
};

// ── Internal helpers ──────────────────────────────────────────────────────────

function looksLikeHeaderRecord(row: Record<string, string>): boolean {
  return (row['_date_'] ?? '').trim() === '_date_' &&
         (row['_action_'] ?? '').trim() === '_action_';
}

