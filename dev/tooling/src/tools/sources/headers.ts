import type { Header } from './types';

/**
 * Build a `Header` from a column list, validating that the required
 * `_date_` and `_action_` columns are present.
 *
 * `source` is a human-readable label (file path or `(vault TABLE_HEADERS)`)
 * used only in error messages.
 */
export function buildHeader(columns: string[], source: string): Header {
  const lower = columns.map(c => c.toLowerCase().trim());

  if (! lower.includes('_date_')) {
    throw new Error(`${source}: columns are missing the _date_ column.\nColumns: ${columns.join(',')}`);
  }

  if (! lower.includes('_action_')) {
    throw new Error(`${source}: columns are missing the _action_ column.\nColumns: ${columns.join(',')}`);
  }

  return {
    columns,
    hasTimestamp: lower.includes('timestamp'),
  };
}
