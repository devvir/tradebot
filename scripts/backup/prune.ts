/**
 * Database pruning via `mongosh`.
 *
 * Spawns `mongosh` directly on the host (must be installed — part of mongodb-mongosh).
 * Scripts are passed via `--eval` to avoid interactive REPL mode.
 * Deletes documents older than a cutoff date using `_id` boundary comparisons —
 * no separate timestamp index needed.
 */
import { spawn } from 'child_process';
import { idBoundary } from './id-boundary';

const runMongosh = (mongoUrl: string, script: string): Promise<string[]> =>
  new Promise((resolve, reject) => {
    const proc = spawn('mongosh', ['--quiet', '--norc', '--eval', script, mongoUrl]);

    const lines: string[] = [];
    let stderr = '';

    proc.stdout.on('data', (chunk: Buffer) => {
      chunk.toString().split('\n').filter(Boolean).forEach(l => lines.push(l));
    });
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    proc.on('close', (code) => {
      if (code === 0) resolve(lines);
      else reject(new Error(`mongosh exited ${code}: ${stderr.trim()}`));
    });
    proc.on('error', reject);
  });

/** Returns all collection names in `database`, excluding system collections (prefix `_`). */
export const getCollections = (mongoUrl: string, database: string): Promise<string[]> =>
  runMongosh(mongoUrl, `
    db.getSiblingDB(${JSON.stringify(database)})
      .getCollectionNames()
      .filter(n => !n.startsWith('_'))
      .forEach(c => print(c));
  `);

/**
 * Deletes (or counts, in dry-run mode) documents older than `cutoffDate` from every
 * non-system collection in `database`.
 */
export const pruneDatabase = async (
  mongoUrl: string,
  database: string,
  cutoffDate: Date,
  dryRun: boolean,
): Promise<void> => {
  const cutoffId = idBoundary(cutoffDate);

  const op = dryRun
    ? `const n = targetDb.getCollection(c).countDocuments({ _id: { $lt: cutoffId } }); print(c + ': would delete ' + n);`
    : `const r = targetDb.getCollection(c).deleteMany({ _id: { $lt: cutoffId } }); print(c + ': deleted ' + r.deletedCount);`;

  const script = `
    const targetDb = db.getSiblingDB(${JSON.stringify(database)});
    const cutoffId = ${cutoffId};
    targetDb.getCollectionNames()
      .filter(n => !n.startsWith('_'))
      .forEach(c => { ${op} });
  `;

  const lines = await runMongosh(mongoUrl, script);
  lines.forEach(l => console.log('  ' + l));
};
