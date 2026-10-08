import type { DatabaseSync } from 'node:sqlite';

/**
 * The partition a name stands for: its id, and the key prefix every file of it
 * starts with. Null where the name is not one, or names none.
 *
 * A partition is named as it is everywhere a person or a log says one:
 *
 *     venue|market|dataset[,variant]|*|grain|YYYYMM     a file per instrument
 *     venue|market|dataset[,variant]|@|grain|YYYYMM     one file for the market
 */
export const partitionNamed = (db: DatabaseSync, name: string): { id: number; prefix: string } | null => {
  const [venue, market, descriptor, mark, grain, month, ...rest] = name.split('|');

  if (! venue || ! market || ! descriptor || ! mark || ! grain || ! month || rest.length > 0) return null;
  if (! ['*', '@'].includes(mark) || ! /^\d{6}$/.test(month)) return null;

  const comma = descriptor.indexOf(',');

  const found = db.prepare(
    `SELECT p.id FROM partition p JOIN slice s ON s.id = p.slice_id
      WHERE s.venue = ? AND s.market = ? AND s.dataset = ? AND s.variant = ? AND s.grain = ? AND s.bundle = ? AND p.month = ?`,
  ).get(
    venue, market, comma < 0 ? descriptor : descriptor.slice(0, comma), comma < 0 ? '' : descriptor.slice(comma + 1),
    grain, mark === '@' ? 'market' : 'instrument', month,
  ) as { id: number } | undefined;

  return found ? { id: found.id, prefix: `${venue}/${market}/${descriptor}/` } : null;
};

/** Whether a lens lets a partition through. */
export const inLens = (db: DatabaseSync, lensId: number, partitionId: number): boolean =>
  db.prepare('SELECT 1 FROM lens_member WHERE lens_id = ? AND partition_id = ?').get(lensId, partitionId) !== undefined;
