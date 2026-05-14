import Table from 'cli-table3';
import { C } from '../../../shared/utils/colors';
import { spacer } from '../log';
import { dashed } from '../ranges';
import { VaultState } from '../scan/types';
import { Layout, TableGroup, buildLayout } from './layout';
import { CellState, Range } from './state';

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

  for (const g of layout.groups) addGroup(cliTable, g);

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

function addGroup(cliTable: Table.Table, g: TableGroup): void {
  const ranges = g.origin === 'rest' ? g.ranges.filter(r => ! r.isToday) : g.ranges;

  if (ranges.length === 0) return;

  const nameCell = {
    content: nameLabel(g),
    rowSpan: ranges.length,
    vAlign:  'top' as const,
  };

  ranges.forEach((r, i) => {
    const isSingleDay = r.startKey === r.endKey;
    const cells = r.states.map(s => renderCellState(s, isSingleDay));
    const label = renderRangeLabel(r);

    if (i === 0) cliTable.push([nameCell, label, ...cells]);
    else         cliTable.push([label, ...cells]);
  });
}

// ── Name column ──────────────────────────────────────────────────────────────

function nameLabel(g: TableGroup): string {
  const status      = deriveStatus(g);
  const statusColor = status === 'up to date' ? C.green : C.yellow;
  const origin      = g.origin.toUpperCase();
  const nameColor   = g.origin === 'ws' ? C.bold : C.white;
  const names       = g.names.map(n => `${nameColor}${n}${C.reset}`).join('\n');

  return `${names}\n${C.dim}${origin}${C.reset}\n${statusColor}${status}${C.reset}`;
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
  if (s.kind === 'missing' || s.kind === 'incomplete' || s.kind === 'mixed') return true;
  if (s.kind === 'half' && (s.bucket === 'missing' || s.sources === 'missing')) return true;

  return false;
}

// ── Range labels ─────────────────────────────────────────────────────────────

/**
 * Renders a range's left-column label.
 *
 *   - today                      → "today"
 *   - single day                 → "2026-01-29"
 *   - full year(s)               → "2021" or "2019 → 2024"
 *   - mixed alignment            → year shorthand on year-aligned endpoints,
 *                                  dashed date otherwise
 *
 * The startKey/endKey carry the actual range boundaries — this function
 * only chooses how to present them.
 */
function renderRangeLabel(r: Range): string {
  if (r.isToday)               return 'today';
  if (r.startKey === r.endKey) return dashed(r.startKey);

  return `${endpointLabel(r.startKey, 'start')} → ${endpointLabel(r.endKey, 'end')}`;
}

function endpointLabel(key: string, role: 'start' | 'end'): string {
  const year = key.slice(0, 4);

  if (role === 'start' && key === `${year}0101`) return year;
  if (role === 'end'   && key === `${year}1231`) return year;

  return dashed(key);
}

// ── Cell rendering ───────────────────────────────────────────────────────────

function renderCellState(s: CellState, isSingleDay: boolean): string {
  switch (s.kind) {
    case 'absent':     return paint('—',             'neutral');
    case 'progress':   return paint('downloading',   'progress');
    case 'pending':    return paint('pending close', 'progress');
    case 'incomplete': return paint('incomplete',    'bad');
    case 'mixed':      return paint('mixed',         'bad');
    case 'buckets':    return paint('buckets',       'good');
    case 'sources':    return paint('sources',       'good');
    case 'stored':     return paint('stored',        'good');
    case 'missing':    return paint('missing',       'bad');
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
