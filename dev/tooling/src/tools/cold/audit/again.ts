import { busy } from '../lock';
import * as record from '../shared/record';
import { warn } from '../../../shared/ui/logger';
import { count } from './finding';
import type { DatabaseSync } from 'node:sqlite';
import type { Tar } from '../types';

/**
 * What a fix looks at again as it is applied. A finding can wait a long time
 * for its answer, and a command can start meanwhile and move on what was found:
 * a fix is applied only to what is still as it was.
 */

/** Whether another cold command is running now, said where it is: what it is working on is not the audit's to touch. */
export const othersAtWork = (coldRoot: string): boolean => {
  if (! busy(coldRoot)) return false;

  warn('Another cold command has started since this was found: left as it is');

  return true;
};

/** Of these tars, the ones still in the state and under the handle they were found with. Says how many are not. */
export const asFound = (db: DatabaseSync, tars: readonly Tar[]): Tar[] => {
  const still = tars.filter((tar) => {
    const now = record.tarById(db, tar.id) as Tar | undefined;

    return now !== undefined && now.state === tar.state && now.handle === tar.handle;
  });

  const moved = tars.length - still.length;

  if (moved > 0) warn(`${count(moved, 'tar')} changed since this was found: left as ${moved === 1 ? 'it is' : 'they are'}`);

  return still;
};
