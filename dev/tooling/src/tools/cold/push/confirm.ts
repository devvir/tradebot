import { remotePath } from '../config';
import * as mega from '../shared/mega';
import * as record from '../shared/record';
import { fileLabelOf, remoteOf } from '../shared/vault/layout';
import type { DatabaseSync } from 'node:sqlite';
import type { Remote } from '../shared/types';
import type { ColdConfig, Origin } from '../types';

/**
 * A second look at what a push has just stored, once it has sent everything it
 * found.
 *
 * **A file is written down as stored the moment Mega shows it**, with the
 * identifier Mega gave it then. That can be overtaken: a file handed over twice
 * is stored twice, and the second replaces the first under another identifier
 * after the first was written down. So what was stored since a moment is asked
 * of Mega again, and the record brought round to what is there:
 *
 * - **another identifier at the size sent** is written down;
 * - **another size, or nothing there**, is written down as not stored, and the
 *   push that is running sends it again.
 *
 * Returns how many of each it found.
 */

/** Vault files stored since a moment. */
export const confirmVault = async (
  db:     DatabaseSync,
  config: ColdConfig,
  since:  string,
  remote: Remote,
  say:    (line: string) => void,
): Promise<{ renamed: number; again: number }> => {
  const found = { renamed: 0, again: 0 };
  const held  = new Map<string, Awaited<ReturnType<Remote['listing']>>>();

  for (const file of record.vaultFilesStoredSince(db, since)) {
    const [venue, ...rest] = remoteOf(file).split('/');

    if (! held.has(venue!)) held.set(venue!, await remote.listing(`${config.megaRoot}/${venue}`));

    const there = held.get(venue!)!.get(rest.join('/'));

    if (! there || there.bytes !== file.bytes) {
      record.moveVaultFile(db, file, 'planned');
      record.dropVaultPartition(db, file.partition, file.revision);

      say(`${fileLabelOf(file.path)} is not in Mega as it was sent — it is sent again`);

      found.again++;
    } else if (there.handle !== file.handle) {
      record.reHandleVaultFile(db, file, there.handle);

      found.renamed++;
    }
  }

  return found;
};

/** Tars stored since a moment. */
export const confirmTars = async (
  db:     DatabaseSync,
  config: ColdConfig,
  origin: Origin,
  since:  string,
  say:    (line: string) => void,
  lookup: (remotePath: string) => Promise<{ bytes: number; handle: string | null } | null> = mega.remote,
): Promise<{ renamed: number; again: number }> => {
  const found = { renamed: 0, again: 0 };

  for (const tar of record.tarsOf(db, origin)) {
    if (tar.state !== 'stored' || ! tar.storedAt || tar.storedAt < since) continue;

    const there = await lookup(remotePath(config, tar));

    if (! there || there.bytes !== tar.bytes) {
      // Its local copy went when it was stored, so it is packed again and not merely handed over.
      record.move(db, tar.id, 'planned');

      say(`${tar.remote} is not in Mega as it was sent — it is packed and sent again`);

      found.again++;
    } else if (there.handle !== tar.handle) {
      record.reHandle(db, tar.id, there.handle);

      found.renamed++;
    }
  }

  return found;
};
