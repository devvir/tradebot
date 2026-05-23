import path from 'node:path';
import fs from 'node:fs';
import { Db } from 'mongodb';
import { info } from '../../../shared/ui/logger';
import { fmtBytes } from '../../../shared/utils/format';
import { fmtNum, fmtElapsed } from '../utils/format';
import { pairFilename, pairKey } from '../types';
import { getEnv } from '../../../shared/utils/env';
import { runMongodump, mongodumpUri } from './mongodump';
import { ProgressBlock } from '../utils/progress-block';
import type { PlanRow } from '../types';
import type { ExecuteDumpOptions } from './types';

const DEFAULT_CONCURRENCY = 4;

// ── Exports ──────────────────────────────────────────────────────────────────

/**
 * Dump each row into `<outDir>/<collection>/<key>.archive.gz` via the
 * `mongodump` CLI. Multiple pairs run in parallel up to `concurrency`
 * (default 4, overridable via `DB_DUMP_CONCURRENCY` env).
 *
 * In-flight archives are written to `<dest>.tmp` and atomically renamed to
 * `<dest>` on success. A leftover `.tmp` file is a forensic marker of a
 * crashed or aborted dump — neither the existing-check (which looks for the
 * sealed name) nor the upload step (which filters them out) will treat it
 * as a real archive.
 *
 * Progress UI: a single fixed multi-line block at the bottom of the terminal
 * showing aggregate progress + one row per active worker with its %.
 * Start/done/fail lines flow above the block as permanent log entries.
 * On non-TTY stdout (file redirect) the live block is suppressed and only
 * the start/done/fail lines are emitted.
 */
export async function executeDump(
  db:      Db,
  rows:    PlanRow[],
  outDir:  string,
  options: ExecuteDumpOptions = {},
): Promise<void> {
  const envConcurrency = parseInt(getEnv('DB_DUMP_CONCURRENCY') ?? '', 10);
  const concurrency    = options.concurrency ?? (
    Number.isFinite(envConcurrency) && envConcurrency > 0 ? envConcurrency : DEFAULT_CONCURRENCY
  );

  const uri      = mongodumpUri();
  const database = db.databaseName;
  const total    = rows.length;

  info(`Dumping ${total} pair${total === 1 ? '' : 's'} via mongodump (concurrency: ${concurrency})`);

  const progress = new ProgressBlock(total);

  let next = 0;

  async function worker(): Promise<void> {
    while (next < total) {
      const idx = next++;
      const row = rows[idx];

      await dumpOne(uri, database, row, idx, total, outDir, progress);
    }
  }

  try {
    const workers = Array.from({ length: Math.min(concurrency, total) }, () => worker());

    await Promise.all(workers);
  } finally {
    progress.stop();
  }
}

// ── Internals ────────────────────────────────────────────────────────────────

async function dumpOne(
  uri:      string,
  database: string,
  row:      PlanRow,
  idx:      number,
  total:    number,
  outDir:   string,
  progress: ProgressBlock,
): Promise<void> {
  const dir     = path.join(outDir, row.collection);
  const file    = pairFilename(row);
  const dest    = path.join(dir, file);
  const tmpDest = `${dest}.tmp`;
  const label   = row.date?.label ?? 'all';
  const prefix  = `[${idx + 1}/${total}] ${row.collection} [${label}]`;
  const key     = pairKey(row);

  fs.mkdirSync(dir, { recursive: true });

  progress.pairStart(key, idx, row);

  try {
    const result = await runMongodump({
      uri,
      database,
      collection:  row.collection,
      query:       row.date ? { _id: { $gte: row.date.startId, $lt: row.date.endId } } : undefined,
      archivePath: tmpDest,
      onProgress:  p => progress.pairUpdate(key, p.done),
    });

    fs.renameSync(tmpDest, dest);  // seal — atomic on same fs

    progress.pairDone(
      key,
      `✓ ${prefix}  ${fmtNum(result.documents)} docs · ${fmtBytes(result.bytes)} · ${fmtElapsed(result.elapsedMs / 1000)}`,
    );
  } catch (err) {
    progress.pairFail(key, `✗ ${prefix}  FAILED: ${(err as Error).message}`);
    // Intentionally leave the .tmp on disk — it's the forensic marker for
    // crashed/aborted dumps. The existing-check looks for the sealed name
    // and won't treat it as already-existing; upload filters .tmp out.
  }
}
