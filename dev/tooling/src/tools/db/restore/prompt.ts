import inquirer from 'inquirer';
import { warn, spacer } from '../../../shared/ui/logger';
import { C } from '../../../shared/utils/colors';
import { fmtBytes } from '../../../shared/utils/format';
import { pad } from '../utils/format';
import type { RestoreTarget, OverlapConflict } from './types';

// ── Exports ──────────────────────────────────────────────────────────────────

export function printOverlaps(overlaps: OverlapConflict[]): void {
  warn('Overlapping archives detected — cannot proceed:');

  for (const c of overlaps) {
    console.log(`  ${c.collection}: ${C.yellow}${c.broader}${C.reset} overlaps with ${C.yellow}${c.narrower}${C.reset}`);
  }

  spacer();
  warn('Each (collection, period) must be unambiguous. Remove one of each pair from local/Mega and retry.');
}

/** Render the discovered targets table. Public so the orchestrator can show it before disk checks. */
export function printRestorePlan(targets: RestoreTarget[]): void {
  printPlan(targets);
}

/** Warn about local-vs-Mega size mismatches. No-op if there are none. */
export function printSizeMismatches(targets: RestoreTarget[]): void {
  const mismatches = targets.filter(t => t.local && t.mega && t.local.size !== t.mega.size);

  if (mismatches.length === 0) return;

  spacer();
  warn(`${mismatches.length} size mismatch${mismatches.length === 1 ? '' : 'es'} (will prefer local — delete local first if you want Mega's copy):`);

  for (const t of mismatches) {
    console.log(`  ${t.collection}/${t.filename}   local: ${C.cyan}${fmtBytes(t.local!.size)}${C.reset}   mega: ${C.cyan}${fmtBytes(t.mega!.size)}${C.reset}`);
  }
}

/** True if at least one target has a local-vs-Mega size mismatch. */
export function hasSizeMismatch(targets: RestoreTarget[]): boolean {
  return targets.some(t => t.local && t.mega && t.local.size !== t.mega.size);
}

/** Main proceed prompt. Default Y / N driven by the caller (mismatches and disk-tight conditions both lean N). */
export async function confirmRestore(targets: RestoreTarget[], defaultYes: boolean): Promise<boolean> {
  spacer();

  const answer = await inquirer.prompt([{
    type:    'confirm',
    name:    'proceed',
    message: `Restore ${targets.length} archive${targets.length === 1 ? '' : 's'}?`,
    default: defaultYes,
  }]);

  return answer.proceed as boolean;
}

/** Fallback prompt when there's room to download but not to import. Default N. */
export async function confirmDownloadOnly(): Promise<boolean> {
  spacer();

  const answer = await inquirer.prompt([{
    type:    'confirm',
    name:    'go',
    message: 'Download from Mega anyway, without importing?',
    default: false,
  }]);

  return answer.go as boolean;
}

/** After successful restore, offer to delete the local archives that were used. */
export async function confirmCleanup(localPaths: string[]): Promise<boolean> {
  if (localPaths.length === 0) return false;

  spacer();

  const answer = await inquirer.prompt([{
    type:    'confirm',
    name:    'cleanup',
    message: `Remove ${localPaths.length} restored archive${localPaths.length === 1 ? '' : 's'} from local?`,
    default: false,
  }]);

  return answer.cleanup as boolean;
}

// ── Internals ────────────────────────────────────────────────────────────────

function printPlan(targets: RestoreTarget[]): void {
  const rows = targets.map(t => ({
    collection: t.collection,
    period:     keyToLabel(t.key),
    source:     source(t),
    size:       fmtBytes(effectiveSize(t)),
    status:     status(t),
  }));

  const cols = [
    { header: 'Collection', align: 'left' as const, get: (r: typeof rows[number]) => r.collection },
    { header: 'Period',     align: 'left' as const, get: (r: typeof rows[number]) => r.period },
    { header: 'Source',     align: 'left' as const, get: (r: typeof rows[number]) => r.source },
    { header: 'Size',       align: 'right' as const, get: (r: typeof rows[number]) => r.size },
    { header: 'Status',     align: 'left' as const, get: (r: typeof rows[number]) => r.status },
  ];

  const widths = cols.map(c => Math.max(c.header.length, ...rows.map(r => stripAnsi(c.get(r)).length)));

  const header = cols.map((c, i) => pad(c.header, widths[i], c.align)).join('  ');
  const sep    = '─'.repeat(header.length);

  console.log(`${C.bold}${header}${C.reset}`);
  console.log(sep);

  for (const row of rows) {
    console.log(cols.map((c, i) => padAnsi(c.get(row), widths[i], c.align)).join('  '));
  }

  console.log(sep);

  const totalBytes = targets.reduce((sum, t) => sum + effectiveSize(t), 0);

  console.log(`${C.bold}${pad('Total', widths[0], 'left')}  ${pad(`${targets.length} archive${targets.length === 1 ? '' : 's'}`, widths[1], 'left')}  ${pad('', widths[2], 'left')}  ${pad(fmtBytes(totalBytes), widths[3], 'right')}${C.reset}`);
}

function keyToLabel(key: string): string {
  if (key === 'all')       return 'all';
  if (key.length === 4)    return key;
  if (key.length === 6)    return `${key.slice(0, 4)}-${key.slice(4, 6)}`;

  return `${key.slice(0, 4)}-${key.slice(4, 6)}-${key.slice(6, 8)}`;
}

function source(t: RestoreTarget): string {
  if (t.local && t.mega) return 'both';
  if (t.local)           return 'local';
  if (t.mega)            return `${C.cyan}mega${C.reset}`;

  return '—';
}

function effectiveSize(t: RestoreTarget): number {
  return t.local?.size ?? t.mega?.size ?? 0;
}

function status(t: RestoreTarget): string {
  if (t.local && t.mega) {
    if (t.local.size !== t.mega.size) return `${C.yellow}⚠ size mismatch (prefer local)${C.reset}`;

    return 'ready';
  }

  if (t.local) return 'ready';
  if (t.mega)  return `${C.cyan}download needed${C.reset}`;

  return `${C.dim}NOT FOUND${C.reset}`;
}

// ── tiny ANSI helpers (local) ────────────────────────────────────────────────

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

function padAnsi(s: string, width: number, align: 'left' | 'right'): string {
  const visible = stripAnsi(s).length;
  const padding = ' '.repeat(Math.max(0, width - visible));

  return align === 'left' ? s + padding : padding + s;
}
