import path from 'node:path';
import { FREE_TEXT_TABLES } from '@tradebot/utils';
import { TableConfig } from './types';

export const KNOWN_TABLES = new Set([
  'announcement',
  'chat',
  'connected',
  'instrument',
  'liquidation',
  'orderBookL2',
  'publicNotifications',
]);

// Source of truth for table column definitions.
// Resolves from our own `dist/` to vault's `dist/` — both packages must be built.
// If this path breaks, vault/src/data/headers.ts has likely moved — update here.
const VAULT_HEADERS_PATH = path.resolve(
  __dirname, '../../../../../services/vault/dist/src/data/headers',
);

function loadTableHeaders(): Record<string, string[]> {
  let mod: { TABLE_HEADERS?: Record<string, string[]> };

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    mod = require(VAULT_HEADERS_PATH) as typeof mod;
  } catch {
    throw new Error(
      `Cannot load vault table headers from: ${VAULT_HEADERS_PATH}\n` +
      `Build vault first ("pnpm build" in services/vault), or check the path in tables.ts.`,
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

// ── Existing API (kept for fix, merge, checks) ────────────────────────────────

/** Returns the config for a known table, or a safe default for unknown ones. */
export function getTableConfig(tableName: string): TableConfig {
  return tableConfigs()[tableName] ?? { timestampCol: null, gapThresholdMs: null };
}

/**
 * Returns the authoritative column list for a table from vault's TABLE_HEADERS,
 * or null when the table is unknown.
 */
export function getVaultColumns(tableName: string): string[] | null {
  return _columnOverrides.get(tableName) ?? tableHeaders()[tableName] ?? null;
}

// ── Prepare pipeline API ──────────────────────────────────────────────────────

const FIXED_PARTIAL_TABLES: ReadonlySet<string> = new Set([
  'announcement',
  'chat',
  'connected',
  'liquidation',
  'publicNotifications',
]);

/** True for tables whose source partials are noise — READ drops them, HEADER writes synthetic one. */
export function hasFixedPartials(tableName: string): boolean {
  return FIXED_PARTIAL_TABLES.has(tableName);
}

/**
 * True when every field in the table is a number, symbol, or ISO timestamp —
 * no free text that could contain commas, quotes, or newlines. READ can skip
 * the full RFC 4180 parser and split on commas directly.
 *
 * Derived from the central FREE_TEXT_TABLES set so data-prepare and vault
 * classify tables identically.
 */
export function allowsSimplifiedParsing(tableName: string): boolean {
  return ! FREE_TEXT_TABLES.has(tableName);
}

/**
 * Gap threshold (ms) for MERGE source-switching.
 * 1ms for tables with an exchange timestamp (instrument, orderBookL2);
 * 60_000ms for timeless tables and everything else.
 */
export function potentialGapThresholdMs(tableName: string): number {
  if (! hasFixedPartials(tableName)) {
    const cols = getVaultColumns(tableName);

    if (cols && cols.includes('timestamp')) {
      return 1;
    }
  }

  return 60_000;
}

// ── Test exports ──────────────────────────────────────────────────────────────

const _columnOverrides: Map<string, string[]> = new Map();

export const _test_setColumns = (tableName: string, columns: string[]): void => {
  _columnOverrides.set(tableName, columns);
};

export const _test_clearColumns = (tableName: string): void => {
  _columnOverrides.delete(tableName);
};
