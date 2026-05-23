import { Db } from 'mongodb';
import { section, spacer, warn } from '../../shared/ui/logger';
import { fmtBytes } from '../../shared/utils/format';
import { C } from '../../shared/utils/colors';
import { getEnv } from '../../shared/utils/env';
import { connectDbTool } from './utils/connect';
import { parseArgs, resolveCollections, buildPairs } from './utils/args';
import { gatherRows, printPlan } from './utils/plan';
import { computeMegaTip, listMegaDir, posixJoin } from './utils/mega';
import type { StatsOptions, CollectionInfo, CollectionInfoColumn } from './types';

// ── Exports ──────────────────────────────────────────────────────────────────

/**
 * `tools db stats [args...]` — two modes, chosen by whether any date arg is
 * given:
 *
 *   - **No dates** → whole-collection stats (count, sizes, indexes) via
 *     `$collStats`. Optional collection-name args filter the list.
 *
 *   - **With dates** → filtered counts in the plan-style table shared with
 *     dump/purge: one row per (collection, date) with approximate doc count
 *     and estimated data size. Storage/index columns are omitted — they're
 *     whole-collection-only via `$collStats` and can't be filtered to a range.
 *
 * Arg parser is the same shared `parseArgs` used by dump/purge: numeric
 * date-shaped args become DateRange filters, others are collection names,
 * `all` expands to every collection.
 */
export async function runStats(args: string[], options: StatsOptions = {}): Promise<void> {
  section('Collection Stats');
  spacer();

  const { dates, rawCollections, useAll } = parseArgs(args);

  const { client, db } = await connectDbTool();

  try {
    const allNames = (await db.listCollections().toArray()).map(c => c.name).sort();

    if (dates.length > 0) {
      await runFiltered(db, allNames, rawCollections, useAll, dates, options);
      return;
    }

    await runWholeCollection(db, allNames, rawCollections, useAll, options);
  } finally {
    await client.close();
  }
}

// ── Modes ────────────────────────────────────────────────────────────────────

async function runFiltered(
  db:              Db,
  allNames:        string[],
  rawCollections:  string[],
  useAll:          boolean,
  dates:           ReturnType<typeof parseArgs>['dates'],
  options:         StatsOptions,
): Promise<void> {
  const collections = resolveCollections(rawCollections, useAll, dates, allNames);
  const pairs       = buildPairs(collections, dates);

  if (pairs.length === 0) {
    warn('No collections to inspect.');
    return;
  }

  spacer();
  const rows = await gatherRows(db, pairs, { exact: options.exact });

  spacer();
  printPlan(rows);
}

async function runWholeCollection(
  db:             Db,
  allNames:       string[],
  rawCollections: string[],
  useAll:         boolean,
  options:        StatsOptions,
): Promise<void> {
  let names = allNames;

  if (! useAll && rawCollections.length > 0) {
    const set     = new Set(rawCollections);
    const missing = rawCollections.filter(n => ! allNames.includes(n));

    names = allNames.filter(n => set.has(n));

    if (missing.length > 0) {
      warn(`Unknown collection${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}`);
    }

    if (names.length === 0) {
      spacer();
      return;
    }
  }

  const rows: CollectionInfo[] = [];

  for (const name of names) {
    rows.push(await fetchStats(db, name, options));
  }

  const tips = await fetchMegaTips(names);

  spacer();
  printTable(rows, tips);
}

/**
 * Look up Mega backup "tip" per collection in parallel. Returns an empty map
 * when `DB_DUMP_MEGA_DIR` is unset — the caller suppresses the column.
 */
async function fetchMegaTips(names: string[]): Promise<Map<string, string | null>> {
  const tips     = new Map<string, string | null>();
  const megaBase = getEnv('DB_DUMP_MEGA_DIR');

  if (! megaBase) return tips;

  await Promise.all(names.map(async name => {
    const files = await listMegaDir(posixJoin(megaBase, name));

    tips.set(name, computeMegaTip(files));
  }));

  return tips;
}

// ── Internals ────────────────────────────────────────────────────────────────

async function fetchStats(db: Db, name: string, options: StatsOptions): Promise<CollectionInfo> {
  const count = options.exact
    ? await db.collection(name).countDocuments({})
    : await db.collection(name).estimatedDocumentCount();

  const [result] = await db.collection(name).aggregate([
    { $collStats: { storageStats: {} } },
  ]).toArray();

  const ss = result?.storageStats ?? {};

  return {
    name,
    count,
    avgObjSize:     ss.avgObjSize     ?? 0,
    dataSize:       ss.size           ?? 0,
    storageSize:    ss.storageSize    ?? 0,
    totalIndexSize: ss.totalIndexSize ?? 0,
    nindexes:       ss.nindexes       ?? 0,
  };
}

function printTable(rows: CollectionInfo[], tips: Map<string, string | null>): void {
  const baseCols: CollectionInfoColumn[] = [
    { header: 'Collection',  align: 'left',  get: r => r.name },
    { header: 'Documents',   align: 'right', get: r => fmtNum(r.count) },
    { header: 'Avg Size',    align: 'right', get: r => fmtBytes(r.avgObjSize) },
    { header: 'Data',        align: 'right', get: r => fmtBytes(r.dataSize) },
    { header: 'Storage',     align: 'right', get: r => fmtBytes(r.storageSize) },
    { header: 'Indexes',     align: 'right', get: r => String(r.nindexes) },
    { header: 'Index Size',  align: 'right', get: r => fmtBytes(r.totalIndexSize) },
  ];

  const megaCol: CollectionInfoColumn = {
    header: 'Backed up',
    align:  'left',
    get:    r => {
      const tip = tips.get(r.name);

      return tip ? `up to ${tip}` : '—';
    },
  };

  const cols = tips.size > 0 ? [...baseCols, megaCol] : baseCols;

  const widths = cols.map(c => Math.max(c.header.length, ...rows.map(r => c.get(r).length)));

  const header = cols.map((c, i) => pad(c.header, widths[i], c.align)).join('  ');

  console.log(`${C.bold}${header}${C.reset}`);
  console.log('─'.repeat(header.length));

  for (const row of rows) {
    const line = cols.map((c, i) => pad(c.get(row), widths[i], c.align)).join('  ');

    console.log(line);
  }

  spacer();
}

function pad(s: string, width: number, align: 'left' | 'right'): string {
  return align === 'left' ? s.padEnd(width) : s.padStart(width);
}

function fmtNum(n: number): string {
  return n.toLocaleString('en-US');
}
