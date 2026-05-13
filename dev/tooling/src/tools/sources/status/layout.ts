import { TableOrigin } from '../scan/tables';
import { TableState, VaultState } from '../scan/types';
import { HoleResult, computeHoles } from './holes';
import { buildRanges } from './range';
import {
  CellState,
  DayKind,
  Range,
  localState,
  megaState,
  remoteState,
  statesEqual,
} from './state';

/**
 * Layer 3 (ranges) + layer 4 (collapsing): produces the pure-data layout
 * the presentation layer consumes. No labels, no colors, no strings beyond
 * structural identifiers and verbatim hole captions.
 *
 *   table state → day-by-day walk → maximal ranges → group identical tables
 */

/** Identical tables (same origin, ranges, notes) collapse into one group. */
export interface TableGroup {
  names:  string[];
  origin: TableOrigin;
  ranges: Range[];
  notes:  string[];            // verbatim from holes.ts; display dedupes them
}

export interface Layout {
  scannedAt: Date;
  locations: string[];         // ['Local', '<remote>', …, 'Mega']
  groups:    TableGroup[];
}

interface TableLayout {
  name:   string;
  origin: TableOrigin;
  ranges: Range[];
  notes:  string[];
}

// ── Entry point ──────────────────────────────────────────────────────────────

export async function buildLayout(state: VaultState): Promise<Layout> {
  const remoteNames     = state.config.remotes.map(r => r.name);
  const locations       = ['Local', ...remoteNames, 'Mega'];
  const now             = new Date();
  const today           = todayYmd(now);
  const yesterday       = previousDay(today);
  // `sources prepare` waits one hour after midnight before finalising the day,
  // so yesterday's `.tmp` is *expected* during 00:00–00:59 UTC.
  const inGraceWindow   = now.getUTCHours() < 1;

  const tables = await Promise.all(
    state.tables.map(t => buildTableLayout(t, remoteNames, today, yesterday, inGraceWindow)),
  );

  return {
    scannedAt: state.scannedAt,
    locations,
    groups:    groupTables(tables),
  };
}

async function buildTableLayout(
  table:           TableState,
  remoteNames:     string[],
  today:           string,
  yesterday:       string,
  inGraceWindow:   boolean,
): Promise<TableLayout> {
  const startYear = computeStartYear(table);

  const fromDay = startYear ? `${startYear}0101` : today;
  const holes   = fromDay <= yesterday
    ? await computeHoles(table.name, table, fromDay, yesterday)
    : { filled: new Set<string>(), notes: [] };

  const ranges = buildTableRanges(table, remoteNames, today, yesterday, inGraceWindow, holes);

  return { name: table.name, origin: table.origin, ranges, notes: holes.notes };
}

// ── Range walking (layer 3) ──────────────────────────────────────────────────

function buildTableRanges(
  table:           TableState,
  remoteNames:     string[],
  today:           string,
  yesterday:       string,
  inGraceWindow:   boolean,
  holes:           HoleResult,
): Range[] {
  const startYear = computeStartYear(table);
  const isWs      = table.origin === 'ws';
  const tarSet    = new Set(table.megaTars);

  if (! startYear || `${startYear}0101` > yesterday) {
    return [todayRange(table, today, remoteNames, isWs, tarSet)];
  }

  const walked = buildRanges<CellState[]>({
    fromDay:  `${startYear}0101`,
    toDay:    yesterday,
    attrFor:  day => {
      const dayKind: DayKind = inGraceWindow && day === yesterday ? 'pending' : 'past';

      return dayStates(table, day, remoteNames, dayKind, isWs, tarSet);
    },
    isFilled: day => holes.filled.has(day),
    equal:    statesEqual,
  });

  const ranges: Range[] = walked
    .map(r => ({ startKey: r.start, endKey: r.end, states: r.attr, isToday: false }))
    .filter(r => ! allAbsent(r.states));

  ranges.push(todayRange(table, today, remoteNames, isWs, tarSet));

  return ranges;
}

function todayRange(
  table:       TableState,
  today:       string,
  remoteNames: string[],
  isWs:        boolean,
  tarSet:      Set<number>,
): Range {
  return {
    startKey: today,
    endKey:   today,
    states:   dayStates(table, today, remoteNames, 'today', isWs, tarSet),
    isToday:  true,
  };
}

function dayStates(
  table:       TableState,
  day:         string,
  remoteNames: string[],
  dayKind:     DayKind,
  isWs:        boolean,
  tarSet:      Set<number>,
): CellState[] {
  const ds     = table.days.get(day);
  const year   = Number(day.slice(0, 4));
  const hasTar = tarSet.has(year);

  const cells: CellState[] = [localState(ds, dayKind, isWs)];

  for (const rn of remoteNames) cells.push(remoteState(ds, rn, dayKind, isWs));

  cells.push(megaState(ds, table.origin, dayKind, hasTar));

  return cells;
}

function allAbsent(states: CellState[]): boolean {
  return states.every(s => s.kind === 'absent');
}

// ── Grouping (layer 4) ───────────────────────────────────────────────────────

/**
 * Collapses tables sharing the same origin, ranges, and notes into one group.
 * The grouping key is a structural JSON of those fields — no presentation
 * text leaks in, so label tweaks downstream can't change grouping.
 */
function groupTables(tables: TableLayout[]): TableGroup[] {
  const byKey = new Map<string, TableGroup>();

  for (const t of tables) {
    const key = JSON.stringify({ origin: t.origin, ranges: t.ranges, notes: t.notes });
    const existing = byKey.get(key);

    if (existing) {
      existing.names.push(t.name);
      continue;
    }

    byKey.set(key, { names: [t.name], origin: t.origin, ranges: t.ranges, notes: t.notes });
  }

  return Array.from(byKey.values());
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function computeStartYear(table: TableState): number | null {
  let min: number | null = null;

  for (const day of table.days.keys()) {
    const y = Number(day.slice(0, 4));

    if (min === null || y < min) min = y;
  }

  for (const y of table.megaTars) {
    if (min === null || y < min) min = y;
  }

  return min;
}

function todayYmd(now: Date): string {
  return now.toISOString().slice(0, 10).replace(/-/g, '');
}

function previousDay(day: string): string {
  const y = Number(day.slice(0, 4));
  const m = Number(day.slice(4, 6));
  const d = Number(day.slice(6, 8));
  const date = new Date(Date.UTC(y, m - 1, d - 1));

  const yy = date.getUTCFullYear().toString().padStart(4, '0');
  const mm = (date.getUTCMonth() + 1).toString().padStart(2, '0');
  const dd = date.getUTCDate().toString().padStart(2, '0');

  return `${yy}${mm}${dd}`;
}
