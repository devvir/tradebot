import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import config from './config';
import type { Built, PartitionKey } from './types';

/**
 * A durable record of every partition ever built, which **survives the
 * partition being deleted**.
 *
 * The steady state is that most of the vault lives in cold storage: a partition
 * is built, backed up, and evicted from local disk while its raw may still be
 * here. A record kept beside the data would go with it, leaving stocker unable
 * to tell "never built" from "built and evicted" — and it would rebuild the lot
 * on the next scan. Keeping it here means reclaiming space is deleting
 * `.parquet` files by any means, including whole subtrees.
 *
 * One append-only file per (table, venue) — around ninety files rather than one
 * per partition, and small enough that a line is written atomically. Appends
 * from concurrent builds are therefore safe without a lock, which a single
 * shared document read-modify-written by several workers would not be.
 */
const DIR = join('@meta', 'built');

/** Later lines supersede earlier ones, so a rebuild simply appends. */
export const load = async (): Promise<Map<string, Built>> => {
  const byId = new Map<string, Built>();
  const dir  = join(config.vaultDir, DIR);

  const { readdir } = await import('node:fs/promises');
  const files = await readdir(dir).catch(() => [] as string[]);

  for (const file of files.filter(f => f.endsWith('.jsonl'))) {
    const raw = await readFile(join(dir, file), 'utf8').catch(() => '');

    for (const line of raw.split('\n')) {
      if (! line.trim()) continue;

      try {
        const entry = JSON.parse(line) as Built;

        byId.set(entry.id, entry);
      } catch {
        // A torn final line from a killed process; the partition simply looks
        // unbuilt and is rebuilt, which is the safe direction.
      }
    }
  }

  return byId;
};

export const record = async (entry: Built): Promise<void> => {
  const dir = join(config.vaultDir, DIR);

  await mkdir(dir, { recursive: true });
  await appendFile(join(dir, fileFor(entry.key)), `${JSON.stringify(entry)}\n`);
};

/**
 * Grouped by (table, venue) so the file a build appends to is predictable and
 * the set stays small, and so a whole table or a whole venue can be reasoned
 * about without reading the rest.
 */
const fileFor = (key: PartitionKey): string => `${key.table}.${key.venue}.jsonl`;
