import { rowToCsv } from '@tradebot/utils';
import { getVaultColumns, hasFixedPartials } from '../../tables';
import type { Writer } from '../../writer';

/**
 * HEADER — write the CSV header row to a writer, plus a synthetic `partial`
 * row at midnight when the table has fixed/empty partials.
 *
 * `tableName` is the only knob: HEADER looks up the column list and the
 * partial-shape rule itself. The columns array is intentionally not in the
 * signature — that detail is HEADER's responsibility, not the caller's.
 *
 * Synthetic partial shape (per design):
 *  - `connected`                                     → all-zero counters: `<date>,partial,0,0,0`
 *  - `announcement`, `chat`, `publicNotifications`,
 *    `liquidation`                                   → empty for every column after `_action_`
 *
 * `<day>` is the YYYYMMDD of the group/target date being processed.
 */
export function writeOutputHeader(
  writer:    Writer,
  tableName: string,
  day:       string,
): void {
  const columns = getVaultColumns(tableName);

  if (! columns)
    throw new Error(`writeOutputHeader: no vault columns for table "${tableName}"`);

  writer.writeHeader({
    columns,
    hasTimestamp: columns.includes('timestamp'),
  });

  if (! hasFixedPartials(tableName))
    return;

  const isoDay = `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}T00:00:00.000Z`;
  const row    = buildSyntheticPartial(tableName, columns, isoDay);

  // The synthetic partial is written as a single raw CSV line; bypassing
  // `writeMessage` keeps HEADER from needing a real `Message` shape. Errors
  // surface when the orchestrator awaits `writer.close()`.
  writer.writeRaw([rowToCsv(row, columns)]).catch(() => { /* surfaces on close() */ });
}

/**
 * Construct the synthetic partial row.
 *
 * `connected` is the only fixed-partial table whose "empty" partial carries
 * data: a tuple of zero counters (`id, users, bots`). All other fixed-partial
 * tables (announcement, chat, publicNotifications, liquidation) have empty
 * values for every column after `_action_`.
 *
 * The decision is made by table identity, not by column name. Several tables
 * share column names like `id` (chat message ID, announcement ID) but those
 * must be empty in their synthetic partial — only `connected` zeros them.
 */
function buildSyntheticPartial(
  tableName: string,
  columns:   string[],
  isoDay:    string,
): Record<string, string> {
  const row: Record<string, string> = {};

  for (const col of columns) {
    if (col === '_date_') {
      row[col] = isoDay;
    } else if (col === '_action_') {
      row[col] = 'partial';
    } else if (tableName === 'connected') {
      row[col] = '0';
    } else {
      row[col] = '';
    }
  }

  return row;
}

// ── Test exports ──────────────────────────────────────────────────────────────

export const _test_buildSyntheticPartial = buildSyntheticPartial;
