import inquirer from 'inquirer';
import { Db } from 'mongodb';
import { spacer } from '../../../shared/ui/logger';
import { fmtBytes } from '../../../shared/utils/format';
import { C } from '../../../shared/utils/colors';
import { writeStatus, clearStatus } from './progress';
import { fmtNum, pad } from './format';
import { estimateRangeCount } from './count';
import type { Pair, PlanRow, GatherOptions, PlanLines } from '../types';

// ── Exports ──────────────────────────────────────────────────────────────────

/**
 * Count documents and fetch `avgObjSize` for each pair, displaying live
 * "Counting [n/total]…" status (so huge collections don't appear stuck).
 *
 * `exact: true` switches both paths to `countDocuments` — accurate but slow
 * on large collections. Dump and purge always run with `exact: false` (the
 * default); `stats` exposes it as the `-e/--exact` flag.
 */
export async function gatherRows(
  db:      Db,
  pairs:   Pair[],
  options: GatherOptions = {},
): Promise<PlanRow[]> {
  const rows: PlanRow[] = [];
  const total = pairs.length;

  // Cache per-collection avgObjSize so we hit collStats at most once per collection.
  const avgCache = new Map<string, number>();

  for (const [idx, pair] of pairs.entries()) {
    const label = pair.date?.label ?? 'all';

    writeStatus(`Counting [${idx + 1}/${total}] ${pair.collection} [${label}]…`);

    if (! avgCache.has(pair.collection)) {
      avgCache.set(pair.collection, await fetchAvgObjSize(db, pair.collection));
    }

    const avgObjSize = avgCache.get(pair.collection) ?? 0;

    const count = pair.date
      ? await estimateRangeCount(db, pair.collection, pair.date, { exact: options.exact })
      : options.exact
        ? await db.collection(pair.collection).countDocuments({})
        : await db.collection(pair.collection).estimatedDocumentCount();

    rows.push({ ...pair, count, avgObjSize });
  }

  clearStatus();

  return rows;
}

/** MongoDB filter for a pair. Empty when there's no date. */
export function filterFor(pair: Pair): Record<string, unknown> {
  if (! pair.date) return {};

  return { _id: { $gte: pair.date.startId, $lt: pair.date.endId } };
}

/** Render the plan table as plain ASCII lines (no colors). Shared by printPlan and the log writer. */
export function formatPlanLines(rows: PlanRow[]): PlanLines {
  const cols = [
    { header: 'Collection',  align: 'left',  get: (r: PlanRow) => r.collection },
    { header: 'Period',      align: 'left',  get: (r: PlanRow) => r.date?.label ?? '—' },
    { header: '~ Documents', align: 'right', get: (r: PlanRow) => fmtNum(r.count) },
    { header: '~ Size',      align: 'right', get: (r: PlanRow) => fmtBytes(r.count * r.avgObjSize) },
  ] as const;

  const widths = cols.map(c => Math.max(c.header.length, ...rows.map(r => c.get(r).length)));

  const header = cols.map((c, i) => pad(c.header, widths[i], c.align)).join('  ');
  const sep    = '─'.repeat(header.length);

  let totalDocs  = 0;
  let totalBytes = 0;

  const lines = rows.map(row => {
    totalDocs  += row.count;
    totalBytes += row.count * row.avgObjSize;

    return cols.map((c, i) => pad(c.get(row), widths[i], c.align)).join('  ');
  });

  const total = [
    pad('Total', widths[0], 'left'),
    pad(`${rows.length} pair${rows.length === 1 ? '' : 's'}`, widths[1], 'left'),
    pad(fmtNum(totalDocs), widths[2], 'right'),
    pad(fmtBytes(totalBytes), widths[3], 'right'),
  ].join('  ');

  return { header, sep, rows: lines, total };
}

export function printPlan(rows: PlanRow[], footer?: string): void {
  const p = formatPlanLines(rows);

  console.log(`${C.bold}${p.header}${C.reset}`);
  console.log(p.sep);
  for (const line of p.rows) console.log(line);
  console.log(p.sep);
  console.log(`${C.bold}${p.total}${C.reset}`);

  if (footer) {
    spacer();
    console.log(footer);
  }
}

export async function confirmProceed(message = 'Proceed?', defaultYes = true): Promise<boolean> {
  const answer = await inquirer.prompt([{
    type:    'confirm',
    name:    'proceed',
    message,
    default: defaultYes,
  }]);

  return answer.proceed as boolean;
}

// ── Internals ────────────────────────────────────────────────────────────────

async function fetchAvgObjSize(db: Db, collection: string): Promise<number> {
  try {
    const [result] = await db.collection(collection).aggregate([
      { $collStats: { storageStats: {} } },
    ]).toArray();

    return result?.storageStats?.avgObjSize ?? 0;
  } catch {
    return 0;
  }
}
