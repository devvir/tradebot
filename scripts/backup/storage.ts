/**
 * Storage abstraction for backup dump files.
 *
 * `BackupStorage` is an interface so the backend can be swapped (e.g. S3) without
 * touching the dump logic. `LocalStorage` is the current implementation.
 */
import { spawn } from 'child_process';
import { type Readable } from 'stream';
import { mkdirSync, createWriteStream } from 'fs';
import { readdir, stat, unlink } from 'fs/promises';
import path from 'path';

export interface BackupStorage {
  /** Streams `source` to a file named `filename` in the storage backend. */
  write(filename: string, source: Readable): Promise<void>;
  /**
   * Deletes dump files older than `olderThanDays` days.
   * Returns the list of deleted filenames (empty if nothing was removed).
   */
  prune(olderThanDays: number, dryRun: boolean): Promise<string[]>;
}

export class LocalStorage implements BackupStorage {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  async write(filename: string, source: Readable): Promise<void> {
    const dest = path.join(this.dir, filename);

    await new Promise<void>((resolve, reject) => {
      const out = createWriteStream(dest);
      source.pipe(out);
      out.on('finish', resolve);
      out.on('error', reject);
      source.on('error', (err) => { out.destroy(err); reject(err); });
    });
  }

  /**
   * Bundles all per-collection `.gz` dump files for `dateStr` into a single
   * `<database>__<dateStr>.tar`, then removes the individual files.
   *
   * The individual files are already gzip-compressed, so no additional compression
   * is applied at the tar level — `tar -cf` (no `z`). Each collection can still be
   * extracted and restored independently:
   *
   *   tar -xf tradebot_archive__2026-03-08.tar tradebot_archive__trade__2026-03-08.gz
   *   mongorestore --gzip --archive=tradebot_archive__trade__2026-03-08.gz
   *
   * Returns the bundle filename, or `null` if there were no files to bundle.
   */
  async bundleDay(database: string, dateStr: string, dryRun: boolean): Promise<string | null> {
    const files = await readdir(this.dir);
    const members = files.filter(f => f.startsWith(`${database}__`) && f.endsWith(`__${dateStr}.gz`));

    if (members.length === 0) return null;

    const bundle = `${database}__${dateStr}.tar`;
    console.log(`  bundle → ${bundle}${dryRun ? ' [dry-run]' : ''}`);

    if (dryRun) return bundle;

    await new Promise<void>((resolve, reject) => {
      const proc = spawn('tar', ['-C', this.dir, '-cf', path.join(this.dir, bundle), ...members]);
      let stderr = '';
      proc.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`tar exited ${code}: ${stderr.trim()}`));
      });
      proc.on('error', reject);
    });

    await Promise.all(members.map(f => unlink(path.join(this.dir, f))));

    return bundle;
  }

  /** Rotates `.tar` bundle files older than `olderThanDays` days. */
  async prune(olderThanDays: number, dryRun: boolean): Promise<string[]> {
    const cutoffMs = Date.now() - olderThanDays * 24 * 3600 * 1000;
    const files = await readdir(this.dir);
    const deleted: string[] = [];

    for (const file of files) {
      if (! file.endsWith('.tar')) continue;

      const fullPath = path.join(this.dir, file);
      const { mtimeMs } = await stat(fullPath);

      if (mtimeMs < cutoffMs) {
        if (! dryRun) await unlink(fullPath);
        deleted.push(file);
      }
    }

    return deleted;
  }
}
