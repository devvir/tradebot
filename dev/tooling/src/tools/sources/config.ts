import path from 'node:path';
import type { TableConfig } from './types';

// Source of truth for table column definitions.
// Resolves from our own `dist/` to vault's `dist/` — both packages must be built.
// If this path breaks, vault/src/storage/headers.ts has likely moved — update here.
const VAULT_HEADERS_PATH = path.resolve(
  __dirname, '../../../../../services/vault/dist/src/storage/headers',
);

function loadTableHeaders(): Record<string, string[]> {
  let mod: { TABLE_HEADERS?: Record<string, string[]> };

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    mod = require(VAULT_HEADERS_PATH) as typeof mod;
  } catch {
    throw new Error(
      `Cannot load vault table headers from: ${VAULT_HEADERS_PATH}\n` +
      `Build vault first ("pnpm build" in services/vault), or check the path in config.ts.`,
    );
  }

  if (! mod.TABLE_HEADERS || typeof mod.TABLE_HEADERS !== 'object') {
    throw new Error(`TABLE_HEADERS not found or invalid in: ${VAULT_HEADERS_PATH}`);
  }

  return mod.TABLE_HEADERS;
}

/** Returns `'timestamp'` when the table has a `timestamp` column, null otherwise. */
function timestampColFor(columns: string[]): string | null {
  return columns.includes('timestamp') ? 'timestamp' : null;
}

/** Tables that run the gap check, with their forward-jump threshold in ms. */
const GAP_THRESHOLDS: Record<string, number> = {
  instrument:  5000,
  orderBookL2: 1000,
};

function gapThresholdFor(tableName: string): number | null {
  return GAP_THRESHOLDS[tableName] ?? null;
}

let _tableHeaders: Record<string, string[]> | null = null;
let _tableConfigs: Record<string, TableConfig>  | null = null;

function tableHeaders(): Record<string, string[]> {
  if (_tableHeaders) {
    return _tableHeaders;
  }

  _tableHeaders = loadTableHeaders();

  return _tableHeaders;
}

function tableConfigs(): Record<string, TableConfig> {
  if (_tableConfigs) {
    return _tableConfigs;
  }

  const headers = tableHeaders();
  const result: Record<string, TableConfig> = {};

  for (const [table, columns] of Object.entries(headers)) {
    result[table] = {
      timestampCol:   timestampColFor(columns),
      gapThresholdMs: gapThresholdFor(table),
    };
  }

  _tableConfigs = result;

  return result;
}

/** Returns the config for a known table, or a safe default for unknown ones. */
export function getTableConfig(tableName: string): TableConfig {
  return tableConfigs()[tableName] ?? { timestampCol: null, gapThresholdMs: null };
}

/**
 * Returns the authoritative column list for a table from vault's TABLE_HEADERS,
 * or null when the table is unknown. Used by the fix pipeline to recover when
 * the source file's own header is missing or malformed.
 */
export function getVaultColumns(tableName: string): string[] | null {
  return tableHeaders()[tableName] ?? null;
}
