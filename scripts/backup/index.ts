import path from 'path';
import { loadConfig } from './config';
import { idBoundary } from './id-boundary';
import { LocalStorage } from './storage';
import { dumpCollection } from './dump';
import { getCollections, pruneDatabase } from './prune';

// Load root .env so credentials don't have to be re-specified.
// Runs before anything else; silently skips if .env doesn't exist.
try { process.loadEnvFile(path.join(process.cwd(), '.env')); } catch { /* no .env */ }

// ── CLI flags ─────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const dryRun    = argv.includes('--dry-run');
const pruneOnly = argv.includes('--prune-only');
const dumpOnly  = argv.includes('--dump-only');

const getDateArg = (): Date | null => {
  const raw = argv.find(a => a.startsWith('--date='));
  if (! raw) return null;

  const d = new Date(raw.slice('--date='.length) + 'T00:00:00.000Z');
  if (isNaN(d.getTime())) throw new Error(`Invalid --date value: ${raw}`);

  return d;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

const yesterday = (): Date => {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - 1);
  return d;
};

const dateStr = (d: Date): string => d.toISOString().slice(0, 10);

// ── Main ──────────────────────────────────────────────────────────────────────

const main = async (): Promise<void> => {
  const config  = loadConfig();
  const storage = new LocalStorage(config.dumpDir);

  const targetDate = getDateArg() ?? yesterday();
  const nextDate   = new Date(targetDate.getTime() + 24 * 3600 * 1000);
  const startId    = idBoundary(targetDate);
  const endId      = idBoundary(nextDate);

  console.log(`[backup] date=${dateStr(targetDate)} startId=${startId} endId=${endId}${dryRun ? ' DRY-RUN' : ''}`);

  if (! pruneOnly) {
    console.log('[backup] enumerating collections...');
    const collections = await getCollections(config.mongoUrl, config.database);
    console.log(`[backup] collections: ${collections.join(', ')}`);

    console.log('[backup] dumping...');
    for (const collection of collections) {
      await dumpCollection(
        config.mongoUrl, config.database, collection,
        dateStr(targetDate), startId, endId, storage, dryRun,
      );
    }

    console.log('[backup] bundling...');
    const bundle = await storage.bundleDay(config.database, dateStr(targetDate), dryRun);
    if (bundle) console.log(`[backup] bundle: ${bundle}`);
  }

  if (! dumpOnly) {
    const cutoffDate = new Date();
    cutoffDate.setUTCHours(0, 0, 0, 0);
    cutoffDate.setUTCDate(cutoffDate.getUTCDate() - config.pruneAgeDays);

    console.log(`[backup] pruning DB docs older than ${dateStr(cutoffDate)}...`);
    await pruneDatabase(config.mongoUrl, config.database, cutoffDate, dryRun);

    console.log(`[backup] rotating dump files older than ${config.retentionDays} days...`);
    const deleted = await storage.prune(config.retentionDays, dryRun);

    if (deleted.length > 0) deleted.forEach(f => console.log(`  removed ${f}${dryRun ? ' [dry-run]' : ''}`));
    else console.log('  (nothing to remove)');
  }

  console.log('[backup] done.');
};

main().catch(err => {
  console.error('[backup] fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
