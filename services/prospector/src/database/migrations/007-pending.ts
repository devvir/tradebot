import { PENDING_INDEX } from '../schema';
import type { Migration } from '../../types';
import type { DatabaseSync } from 'node:sqlite';

/**
 * 6 → 7. An index over the files not yet downloaded, for listings asked for
 * what is still owed.
 */
export const pendingIndex: Migration = {
  name: 'pending',
  run:  (db: DatabaseSync) => {
    db.exec(PENDING_INDEX);
  },
};
