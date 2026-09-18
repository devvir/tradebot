import { CART_SCHEMA } from '../schema';
import type { Migration } from '../../types';

/**
 * 4 → 5. Carts: what somebody wants on disk, kept where the catalog is.
 *
 * **Shape and nothing else.** A cart is a person's decision, so none ships — a
 * fresh catalog has no carts and is not missing anything.
 *
 * **The same statements `CATALOG_SCHEMA` carries**, so a database built from
 * nothing gets these tables from the baseline and one already in service gets
 * them here. Both are `IF NOT EXISTS`, so whichever runs second does nothing.
 */
export const carts: Migration = {
  name: 'carts',

  sql: CART_SCHEMA,
};
