/**
 * Collection dump using `mongodump`.
 *
 * Spawns `mongodump` directly on the host (must be installed — part of mongodb-database-tools).
 * Archives a single collection for a specific date range, filtered by `_id` boundary values,
 * and streams the gzip output straight to the storage backend without a temp file.
 */
import { spawn } from 'child_process';
import { type Readable } from 'stream';
import { type BackupStorage } from './storage';

const mongodump = (
  mongoUrl: string,
  database: string,
  collection: string,
  query: Record<string, unknown>,
): { stdout: Readable; exit: Promise<void> } => {
  const proc = spawn('mongodump', [
    '--uri',        mongoUrl,
    '--db',         database,
    '--collection', collection,
    '--query',      JSON.stringify(query),
    '--gzip', '--archive',
  ]);

  if (! proc.stdout) throw new Error('mongodump process has no stdout');

  let stderr = '';
  proc.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

  const exit = new Promise<void>((resolve, reject) => {
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`mongodump exited ${code}: ${stderr.trim()}`));
    });
    proc.on('error', reject);
  });

  return { stdout: proc.stdout, exit };
};

/**
 * Dumps one collection for a UTC day into a gzip archive.
 *
 * The query `{ _id: { $gte: startId, $lt: endId } }` selects only documents whose
 * embedded timestamp falls within the target day — no separate date index needed.
 * Output filename: `<database>__<collection>__<YYYY-MM-DD>.gz`
 */
export const dumpCollection = async (
  mongoUrl: string,
  database: string,
  collection: string,
  dateStr: string,
  startId: number,
  endId: number,
  storage: BackupStorage,
  dryRun: boolean,
): Promise<void> => {
  const filename = `${database}__${collection}__${dateStr}.gz`;
  console.log(`  dump  ${collection} → ${filename}${dryRun ? ' [dry-run]' : ''}`);

  if (dryRun) return;

  const query = { _id: { $gte: startId, $lt: endId } };
  const { stdout, exit } = mongodump(mongoUrl, database, collection, query);
  await Promise.all([storage.write(filename, stdout), exit]);
};
