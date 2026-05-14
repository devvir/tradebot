import type { Writable } from 'node:stream';
import { getVaultColumns, hasFixedPartials } from '../../tables';

/**
 * Write the CSV header row, plus a synthetic `partial` row at midnight for
 * tables that have fixed/empty partials.
 */
export function writeOutputHeader(
  out:       Writable,
  tableName: string,
  day:       string,
): void {
  const columns = getVaultColumns(tableName);

  if (! columns)
    throw new Error(`writeOutputHeader: no vault columns for table "${tableName}"`);

  out.write(columns.join(',') + '\n');

  if (! hasFixedPartials(tableName))
    return;

  const isoDay = `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}T00:00:00.000Z`;
  const line   = buildSyntheticPartial(tableName, columns, isoDay);

  out.write(line + '\n');
}

/**
 * `connected` is the only fixed-partial table whose synthetic partial
 * carries zero-valued counters; every other table emits empty fields after
 * `_action_`. The decision is by table identity, not column name — multiple
 * tables share column names like `id` but only `connected` zeros them.
 */
function buildSyntheticPartial(
  tableName: string,
  columns:   string[],
  isoDay:    string,
): string {
  return columns.map((_col, i) => {
    if (i === 0) return isoDay;
    if (i === 1) return 'partial';

    return tableName === 'connected' ? '0' : '';
  }).join(',');
}

// ── Test exports ──────────────────────────────────────────────────────────────

export const _test_buildSyntheticPartial = buildSyntheticPartial;
