import { LENS_SCHEMA } from '../schema';
import type { Migration } from '../../types';
import type { DatabaseSync } from 'node:sqlite';

/**
 * 6 → 7. Carts become lenses.
 *
 * **A rename, and a different idea.** A cart was a list to hand a downloader; a
 * lens is what a consumer sees the catalog through — where one is in force, its
 * slice *is* the catalog. The change that matters is not the word: a cart's lines
 * could only ever add, so "everything up to a date, except books" had to be
 * written as its complement. A lens is an ordered list of rules that include and
 * exclude, which is how that sentence is actually meant.
 *
 * **The cart tables are dropped rather than migrated.** They never held a row in
 * any deployment, and a line whose only operation is `include` carries nothing a
 * rule needs.
 */
export const lenses: Migration = {
  name: 'lens',
  run:  (db: DatabaseSync) => {
    db.exec(LENS_SCHEMA);
    db.exec('DROP TABLE IF EXISTS cart_item');
    db.exec('DROP TABLE IF EXISTS cart');
  },
};
