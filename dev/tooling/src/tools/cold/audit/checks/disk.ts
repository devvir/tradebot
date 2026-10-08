import fs from 'node:fs';
import path from 'node:path';
import { discard } from '../../evict/discard';
import { idOf } from '../../shared/keys';
import * as record from '../../shared/record';
import { fileLabelOf } from '../../shared/vault/layout';
import { stockedIn } from '../../shared/vault/ledger';
import { are, count, found } from '../finding';
import type { StoredFile } from '../../shared/types';
import type { Check, Finding, Looking } from '../types';

/**
 * The record against the local disk: is what is written down as taken off it
 * really away, and what is not, really there.
 *
 * Neither is a loss — cold storage holds all of it either way — but the record
 * is what `evict` and `pull` go by, and one that is wrong about the disk makes
 * them offer the wrong things.
 */
export const againstDisk: Check = async looking => (looking.origin === 'vault' ? vault(looking) : archives(looking));

// ── Internals ─────────────────────────────────────────────────────────────────

/** Vault files of the revision the ledger has now, each where the record says it should or should not be. */
const vault = (looking: Looking): Finding[] => {
  const { db, config } = looking;

  const current = new Map((stockedIn(config.vaultRoot) ?? []).map(one => [one.partition, one.revision]));
  const files   = record.vaultFiles(db).filter(file => file.state === 'stored' && current.get(file.partition) === file.revision);

  const here = (file: StoredFile): boolean => {
    try {
      return fs.statSync(path.join(config.vaultRoot, file.path)).size === file.bytes;
    } catch {
      return false;
    }
  };

  const back = files.filter(file => file.evictedAt !== null && here(file));
  const away = files.filter(file => file.evictedAt === null && ! fs.existsSync(path.join(config.vaultRoot, file.path)));

  return [
    found(`${count(back.length, 'vault file')} written down as taken off the disk ${are(back)} on it, at the size stored`, back.map(file => fileLabelOf(file.path)), [
      { label: 'Write them down as back', apply: () => record.noteVaultMoves(db, back, 'restored') },
      { label: 'Remove them from the disk again', destructive: true, apply: () => discard(back.map(file => path.join(config.vaultRoot, file.path)), true) },
    ]),
    found(`${count(away.length, 'vault file')} written down as on the disk ${are(away)} not there`, away.map(file => fileLabelOf(file.path)), [
      { label: 'Write them down as taken off the disk', apply: () => record.noteVaultMoves(db, away, 'evicted') },
    ], 'Cold storage holds them: they come back with `cold pull vault`.'),
  ].flat();
};

/** Partitions of the archives written down as taken off the disk, that have files on it. */
const archives = async (looking: Looking): Promise<Finding[]> => {
  const { db, config, origin } = looking;

  const back: { key: ReturnType<typeof record.evictionsOf>[number]; files: string[] }[] = [];

  for (const key of record.evictionsOf(db, origin)) {
    const files = await looking.archives.filesOf(key);

    if (files.length > 0) back.push({ key, files: files.map(file => path.join(config.sourceRoot, file.path)) });
  }

  return found(`${count(back.length, 'partition')} of the archives written down as taken off the disk ${back.length === 1 ? 'has' : 'have'} files on it`,
    back.map(one => idOf(one.key)), [
      { label: 'Write them down as back', apply: () => { for (const one of back) record.noteReturn(db, origin, one.key); } },
      { label: 'Remove their files from the disk again', destructive: true, apply: () => discard(back.flatMap(one => one.files), true) },
    ], 'Downloaded again, or brought back by hand. Written down as back, `cold evict` weighs them again like any other.');
};
