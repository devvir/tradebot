import { WS_TABLES } from '@tradebot/utils';
import type { BitmexTable } from '@tradebot/types';
import type { TableKind, RestKind } from './types';

/**
 * The catalog: how each public table is stored, and which surfaces it serves.
 * Built on `@tradebot/utils` so there is one source of truth for table shapes.
 *
 *   message   — stored as full WS messages (the 7 `WS_TABLES`). Republished as-is.
 *   flat      — stored as flat records (trade, quote, funding, settlement,
 *               insurance, the 8 bins). Wrapped into WS `insert` messages; served
 *               on REST as records.
 *   orderbook — orderBook10 / orderBookL2_25. Deferred — served empty (§ REPLAY.md).
 */

/**
 * Deferred / skipped for now (return `null` → 404):
 *   orderBook10 / orderBookL2_25 — pending their distiller (served empty meanwhile).
 *   compositeIndex — a REST table (`/instrument/compositeIndex/`).
 *   tick — referential index "trades" (fake, for indices not symbols), served on
 *          rest + ws; may be merged into `trade` later.
 * Revisit if a bot needs them.
 */
const ORDERBOOK_TABLES = new Set<string>([ 'orderBook10', 'orderBookL2_25' ]);

const FLAT_TABLES = new Set<string>([
  'trade', 'quote', 'funding', 'settlement', 'insurance',
  'tradeBin1m', 'tradeBin5m', 'tradeBin1h', 'tradeBin1d',
  'quoteBin1m', 'quoteBin5m', 'quoteBin1h', 'quoteBin1d',
]);

// ── Public API ────────────────────────────────────────────────────────────────

export const tableKind = (table: string): TableKind | null => {
  if (WS_TABLES.has(table))        return 'message';
  if (ORDERBOOK_TABLES.has(table)) return 'orderbook';
  if (FLAT_TABLES.has(table))      return 'flat';

  return null;
};

export const isKnown = (table: string): table is BitmexTable =>
  tableKind(table) !== null;

/** Tables the provider serves a WS stream for (all known public tables). */
export const isWsServed = (table: string): boolean =>
  tableKind(table) !== null;

/** `trade` records sharing `timestamp + symbol` group into one `insert`. */
export const needsGrouping = (table: string): boolean =>
  table === 'trade';

// ── REST surface ────────────────────────────────────────────────────────────

/** Current row set reconstructed at the clock — symbol-keyed full-state tables. */
const STATE_TABLES = new Set<string>([ 'orderBookL2', 'instrument', 'liquidation' ]);

/** Last-N records, no time filtering (BitMEX returns recent only). */
const RECENT_TABLES = new Set<string>([ 'chat', 'announcement' ]);

/**
 * REST strategy per table (verified against swagger.json + live API). `null` for
 * tables with no BitMEX REST endpoint (connected, publicNotifications,
 * orderBook10, orderBookL2_25). The flat tables are the historical-range set.
 */
export const restKind = (table: string): RestKind | null => {
  if (STATE_TABLES.has(table))     return 'state';
  if (RECENT_TABLES.has(table))    return 'recent';
  if (tableKind(table) === 'flat') return 'historical';

  return null;
};

/** Tables the provider serves REST for. */
export const isRestServed = (table: string): boolean =>
  restKind(table) !== null;
