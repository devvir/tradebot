import { C } from '../../../shared/utils/colors';
import { spacer } from '../log';
import {
  BackupBucketTask,
  BackupSourceTask,
  CleanRsyncTempsTask,
  CleanupTask,
  DeleteLocalBucketsTask,
  PrepareTask,
  PullTask,
  Task,
} from './types';

const MAX_PREVIEW = 8;

// ── Summary ───────────────────────────────────────────────────────────────────

/**
 * Prints the pre-task bullet-list summary. One line per task type with work;
 * nothing printed for idle task types. Prints "everything is up to date" when
 * there is nothing to do.
 */
export function printSummary(tasks: Task[]): void {
  spacer();

  if (tasks.length === 0) {
    console.log(`  ${C.green}✓ everything is up to date${C.reset}`);
    spacer();

    return;
  }

  for (const task of tasks) {
    const line    = summaryLine(task);
    const warning = task.isAbnormal ? `  ${C.yellow}⚠ review required${C.reset}` : '';

    console.log(`  ${C.dim}•${C.reset} ${line}${warning}`);
  }

  spacer();
}

function summaryLine(task: Task): string {
  if (task.kind === 'clean-rsync-temps')    return cleanRsyncTempsSummary(task);
  if (task.kind === 'pull')                 return pullSummary(task);
  if (task.kind === 'backup-source')        return backupSourceSummary(task);
  if (task.kind === 'prepare')              return prepareSummary(task);
  if (task.kind === 'backup-bucket')        return backupBucketSummary(task);
  if (task.kind === 'delete-local-buckets') return deleteLocalBucketsSummary(task);

  return cleanupSummary(task);
}

function cleanupSummary(task: CleanupTask): string {
  const tables = countDistinctTables(task.files);
  const n      = task.files.length;
  const local  = task.files.filter(f => f.location === 'local').length;
  const remote = n - local;

  const breakdown = local > 0 && remote > 0
    ? ` ${C.dim}(${local} local, ${remote} remote)${C.reset}`
    : '';

  return `${C.bold}${n}${C.reset}${breakdown} source file${n === 1 ? '' : 's'} from ${tables} table${tables === 1 ? '' : 's'} can be moved to .trash`;
}

function cleanRsyncTempsSummary(task: CleanRsyncTempsTask): string {
  const n = task.files.length;

  return `${C.yellow}${C.bold}${n}${C.reset}${C.yellow} interrupted rsync temp file${n === 1 ? '' : 's'} can be removed${C.reset}`;
}

function pullSummary(task: PullTask): string {
  const tables = countDistinctTables(task.files);
  const n      = task.files.length;

  return `${C.bold}${n}${C.reset} source${n === 1 ? '' : 's'} for ${tables} table${tables === 1 ? '' : 's'} can be pulled from ${C.bold}${task.remote}${C.reset}`;
}

function backupSourceSummary(task: BackupSourceTask): string {
  const tables  = countDistinctTables(task.files);
  const n       = task.files.length;
  const pulled  = task.files.filter(f => f.fromPull).length;
  const present = n - pulled;

  const count = `${C.bold}${n}${C.reset}${formatBreakdown(present, pulled, 'pulled')}`;

  return `${count} source file${n === 1 ? '' : 's'} from ${tables} table${tables === 1 ? '' : 's'} can be backed up in Mega`;
}

function prepareSummary(task: PrepareTask): string {
  const dayCount   = task.groups.reduce((sum, g) => sum + g.days.length, 0);
  const tableCount = new Set(task.groups.map(g => g.table)).size;

  return `${C.bold}${dayCount}${C.reset} date${dayCount === 1 ? '' : 's'} for ${tableCount} table${tableCount === 1 ? '' : 's'} can be prepared (sources → bucket)`;
}

function backupBucketSummary(task: BackupBucketTask): string {
  const tables   = countDistinctTables(task.files);
  const n        = task.files.length;
  const prepared = task.files.filter(f => f.fromPrepare).length;
  const present  = n - prepared;

  const count = `${C.bold}${n}${C.reset}${formatBreakdown(present, prepared, 'prepared')}`;

  return `${count} bucket file${n === 1 ? '' : 's'} from ${tables} table${tables === 1 ? '' : 's'} can be backed up in Mega`;
}

function deleteLocalBucketsSummary(task: DeleteLocalBucketsTask): string {
  const n      = task.ranges.reduce((sum, r) => sum + r.days.length, 0);
  const tables = new Set(task.ranges.map(r => r.table)).size;
  const ranges = task.ranges.length;

  const rangeNote = ranges > 1 ? ` ${C.dim}(${ranges} ranges)${C.reset}` : '';

  return `${C.bold}${n}${C.reset} local bucket file${n === 1 ? '' : 's'} from ${tables} table${tables === 1 ? '' : 's'} can be deleted (backed up in Mega)${rangeNote}`;
}

/**
 * Renders the `(X present, Y pulled/prepared)` annotation. Returns an empty
 * string when there's nothing conditional — keeps the line clean when the
 * count is fully certain.
 */
function formatBreakdown(present: number, conditional: number, verb: string): string {
  if (conditional === 0) return '';

  if (present === 0)     return ` ${C.dim}(${conditional} ${verb})${C.reset}`;

  return ` ${C.dim}(${present} present, ${conditional} ${verb})${C.reset}`;
}

// ── Preview ───────────────────────────────────────────────────────────────────

/**
 * Prints a short preview of the files in a task (up to MAX_PREVIEW lines, then
 * a "… N more" tail). Called inside the interactive loop before prompting.
 */
export function printPreview(task: Task): void {
  if (task.kind === 'clean-rsync-temps') {
    task.files.slice(0, MAX_PREVIEW).forEach(f => {
      console.log(`  ${C.dim}${f.table}/${f.year}/${C.reset}${f.filename}`);
    });

    const total = task.files.length;

    if (total > MAX_PREVIEW) {
      console.log(`  ${C.dim}… ${total - MAX_PREVIEW} more${C.reset}`);
    }

    return;
  }

  if (task.kind === 'prepare') {
    for (const g of task.groups) {
      const first = g.days[0]!;
      const last  = g.days[g.days.length - 1]!;
      const range = first === last ? first : `${first} → ${last}`;

      console.log(`  ${C.dim}${g.table}/${g.year}${C.reset}  ${g.days.length} day${g.days.length === 1 ? '' : 's'}  ${C.dim}(${range})${C.reset}`);
    }

    return;
  }

  if (task.kind === 'delete-local-buckets') {
    for (const r of task.ranges) {
      const first = r.days[0]!;
      const last  = r.days[r.days.length - 1]!;
      const range = first === last ? first : `${first} → ${last}`;

      console.log(`  ${C.dim}${r.table}/${r.year}${C.reset}  ${r.days.length} day${r.days.length === 1 ? '' : 's'}  ${C.dim}(${range})${C.reset}`);
    }

    return;
  }

  if (task.kind === 'pull') {
    task.files.slice(0, MAX_PREVIEW).forEach(f => {
      console.log(`  ${C.dim}${f.table}/${f.year}/${C.reset}${f.day}.${f.suffix}.csv.gz`);
    });
  } else if (task.kind === 'backup-source') {
    task.files.slice(0, MAX_PREVIEW).forEach(f => {
      console.log(`  ${C.dim}${f.table}/${f.year}/${C.reset}${f.day}.${f.suffix}.csv.gz`);
    });
  } else if (task.kind === 'backup-bucket') {
    task.files.slice(0, MAX_PREVIEW).forEach(f => {
      console.log(`  ${C.dim}${f.table}/${f.year}/${C.reset}${f.day}.csv.gz`);
    });
  } else {
    // cleanup
    task.files.slice(0, MAX_PREVIEW).forEach(f => {
      const tag = f.location === 'local' ? 'local      ' : `${f.remote}`.padEnd(11);

      console.log(`  ${C.dim}${tag}${C.reset}  ${C.dim}${f.table}/${f.year}/${C.reset}${f.day}.${f.suffix}.csv.gz`);
    });
  }

  const total = task.files.length;

  if (total > MAX_PREVIEW) {
    console.log(`  ${C.dim}… ${total - MAX_PREVIEW} more${C.reset}`);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function countDistinctTables(files: { table: string }[]): number {
  return new Set(files.map(f => f.table)).size;
}
