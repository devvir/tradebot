import { PENDING_INDEX } from '../schema';
import type { Migration } from '../../types';
import type { DatabaseSync } from 'node:sqlite';

/**
 * 8 → 9. An index over the files not yet downloaded, for bucket listings asked
 * for what is still owed — see `bucket.ts`.
 */
export const pendingIndex: Migration = {
  name: 'pending',
  run:  (db: DatabaseSync) => {
    db.exec(PENDING_INDEX);
  },
};
