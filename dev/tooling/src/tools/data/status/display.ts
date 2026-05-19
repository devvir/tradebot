import Table from 'cli-table3';
import { C } from '../../../shared/utils/colors';
import { spacer } from '../log';
import { dashed } from '../ranges';
import { type Layout, type TableGroup, buildLayout } from './layout';
import type { VaultState } from '../scan/types';
import type { CellState, Range } from './state';

type LabelContext = {
  yesterday:      string;
  databaseColumn: number;  // index in `layout.locations`; -1 if absent
};

/**
 * Layer 5 (presentation): turns the structural `Layout` into a printable
 * grid. Owns every label, color, and cli-table3 cell — no presentation
 * decisions live in the data layers.
 */

type Color = 'good' | 'bad' | 'progress' | 'neutral';

export async function printTable(state: VaultState): Promise<void> {
  const layout = await buildLayout(state);

  spacer();
  console.log(`${C.bold}${C.cyan}Data — current state${C.reset}`);
  console.log(`${C.dim}scanned at ${state.scannedAt.toISOString()}${C.reset}`);
  spacer();

  const cliTable = new Table({
    head:  buildHeader(layout),
    style: { head: [], border: [] },
  });

  const ctx: LabelContext = {
    yesterday:       layout.yesterday,
    databaseColumn:  layout.locations.indexOf('Database'),
  };

  for (const g of layout.groups) addGroup(cliTable, g, ctx);

  process.stdout.write('\x1b[H\x1b[J');
  console.log(cliTable.toString());

  printNotes(layout.groups);
  spacer();
}

function buildHeader(layout: Layout): string[] {
  return [
    `${C.bold}Table${C.reset}`,
    `${C.bold}Range${C.reset}`,
    ...layout.locations.map(l => `${C.bold}${l}${C.reset}`),
  ];
}

function addGroup(cliTable: Table.Table, g: TableGroup, ctx: LabelContext): void {
  const ranges = g.origin === 'rest' ? g.ranges.filter(r => ! r.isToday) : g.ranges;

  if (ranges.length === 0) return;

  // WS rows render in bold bright white, REST rows in a dimmer standard white
  // — so the two origins are tellable apart at a glance. The same shade
  // applies to every white cell in the row: table names and range labels.
  const textColor = g.origin === 'ws' ? C.bold : C.white;

  const nameCell = {
    content: nameLabel(g, textColor),
    rowSpan: ranges.length,
    vAlign:  'top' as const,
  };

  ranges.forEach((r, i) => {
    const isSingleDay = r.startKey === r.endKey;
    const cells = r.states.map((s, col) => renderCellState(s, isSingleDay, col === ctx.databaseColumn));
    const label = `${textColor}${renderRangeLabel(r, i === 0, ctx)}${C.reset}`;

    if (i === 0) cliTable.push([nameCell, label, ...cells]);
    else         cliTable.push([label, ...cells]);
  });
}

// ── Name column ──────────────────────────────────────────────────────────────

function nameLabel(g: TableGroup, textColor: string): string {
  const status      = deriveStatus(g);
  const statusColor = status === 'up to date' ? C.green : C.yellow;
  const origin      = g.origin.toUpperCase();
  const names       = g.names.map(n => `${textColor}${n}${C.reset}`).join('\n');

  return `${names}\n${C.dim}${origin} · ${C.reset}${statusColor}${status}${C.reset}`;
}

function deriveStatus(g: TableGroup): 'up to date' | 'partial' {
  for (const r of g.ranges) {
    for (const s of r.states) {
      if (isBadState(s)) return 'partial';
    }
  }

  return 'up to date';
}

function isBadState(s: CellState): boolean {
  if (s.kind === 'missing' || s.kind === 'incomplete' || s.kind === 'mixed' || s.kind === 'importing') return true;
  if (s.kind === 'half' && (s.bucket === 'missing' || s.sources === 'missing')) return true;

  return false;
}

// ── Range labels ─────────────────────────────────────────────────────────────

/**
 * Renders a range's left-column label.
 *
 *   - today                      → "today"
 *   - single day = yesterday     → "yesterday"
 *   - single day                 → "2026-01-29"
 *   - first range start          → just the year ("2014")
 *   - endpoint = yesterday       → "yesterday"
 *   - full year(s)               → "2021" or "2019 → 2024"
 *   - mixed alignment            → year shorthand on year-aligned endpoints,
 *                                  dashed date otherwise
 *
 * The startKey/endKey carry the actual range boundaries — this function
 * only chooses how to present them.
 *
 * When start and end resolve to the same label (e.g. start = "2014",
 * end = "2014" because endKey was 20141231) the arrow form collapses to
 * just that label.
 */
function renderRangeLabel(r: Range, isFirst: boolean, ctx: LabelContext): string {
  if (r.isToday) return 'today';

  if (r.startKey === r.endKey) {
    return r.startKey === ctx.yesterday ? 'yesterday' : dashed(r.startKey);
  }

  const start = endpointLabel(r.startKey, 'start', isFirst, ctx);
  const end   = endpointLabel(r.endKey,   'end',   false,   ctx);

  return start === end ? start : `${start} → ${end}`;
}

function endpointLabel(key: string, role: 'start' | 'end', isFirstStart: boolean, ctx: LabelContext): string {
  if (key === ctx.yesterday) return 'yesterday';

  const year = key.slice(0, 4);

  if (role === 'start' && isFirstStart)          return year;
  if (role === 'start' && key === `${year}0101`) return year;
  if (role === 'end'   && key === `${year}1231`) return year;

  return dashed(key);
}

// ── Cell rendering ───────────────────────────────────────────────────────────

function renderCellState(s: CellState, isSingleDay: boolean, isDatabaseColumn: boolean): string {
  switch (s.kind) {
    case 'absent':     return paint('—',             'neutral');
    case 'progress':   return paint('downloading',   'progress');
    case 'pending':    return paint('pending close', 'progress');
    case 'incomplete': return paint('incomplete',    'bad');
    case 'mixed':      return paint('mixed',         'bad');
    case 'buckets':    return paint('buckets',       'good');
    case 'sources':    return paint('sources',       'good');
    case 'stored':     return paint('stored',        'good');
    case 'missing':    return paint(isDatabaseColumn ? 'pending' : 'missing', 'bad');
    case 'importing':  return paint('importing',     'progress');
    case 'imported':   return paint('imported',      'good');
    case 'half':       return renderHalf(s, isSingleDay);
  }
}

/** Half-stored Mega cell: stored line first (green), missing line second (yellow). */
function renderHalf(s: Extract<CellState, { kind: 'half' }>, isSingleDay: boolean): string {
  const bucket = isSingleDay ? 'bucket' : 'buckets';
  const lines  = s.bucket === 'stored'
    ? [paint(`${bucket} stored`,  'good'), paint('sources missing', 'bad')]
    : [paint('sources stored', 'good'), paint(`${bucket} missing`,  'bad')];

  return lines.join('\n');
}

function paint(text: string, color: Color): string {
  return `${colorCode(color)}${text}${C.reset}`;
}

function colorCode(color: Color): string {
  switch (color) {
    case 'good':     return C.green;
    case 'bad':      return C.yellow;
    case 'progress': return C.cyan;
    case 'neutral':  return C.dim;
  }
}

// ── Notes ────────────────────────────────────────────────────────────────────

function printNotes(groups: TableGroup[]): void {
  const seen = new Set<string>();
  const unique: string[] = [];

  for (const g of groups) {
    for (const note of g.notes) {
      if (! seen.has(note)) {
        seen.add(note);
        unique.push(note);
      }
    }
  }

  if (unique.length === 0) return;

  spacer();

  for (const note of unique) {
    console.log(`  ${C.dim}${note}${C.reset}`);
  }
}
