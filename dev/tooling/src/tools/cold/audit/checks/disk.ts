import fs from 'node:fs';
import path from 'node:path';
import { discard } from '../../evict/discard';
import { survey } from '../../evict/archives/survey';
import * as catalog from '../../shared/catalog';
import { idOf } from '../../shared/keys';
import * as record from '../../shared/record';
import { fileLabelOf } from '../../shared/vault/layout';
import { stockedIn } from '../../shared/vault/ledger';
import { are, count, found } from '../finding';
import { warn } from '../../../../shared/ui/logger';
import type { PartitionKey, StoredFile } from '../../shared/types';
import type { Check, Finding, Looking } from '../types';

/**
 * The record against the local disk: is what is written down as taken off it
 * really away, and what is not, really there. The record is what `evict` and
 * `pull` go by, and one that is wrong about the disk makes them offer the wrong
 * things.
 *
 * **What is on disk again can be taken off it again only where cold storage
 * holds it as it is.** A vault file is offered for that at the revision the
 * ledger has now, stored at the size it is. A partition of the archives only
 * where `evict --cleanup` would take it: stored at the version the catalog has
 * now, with no change noted, and stocked — and evicted at that version, so the
 * files are the ones that went. What is newer than cold storage's copy is only
 * written down as back. Either removal goes to the host's trash.
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
      { label: 'Remove them from the disk again', destructive: true, apply: () => discard(back.map(file => path.join(config.vaultRoot, file.path)), false) },
    ]),
    found(`${count(away.length, 'vault file')} written down as on the disk ${are(away)} not there`, away.map(file => fileLabelOf(file.path)), [
      { label: 'Write them down as taken off the disk', apply: () => record.noteVaultMoves(db, away, 'evicted') },
    ], 'Cold storage holds them: they come back with `cold pull vault`.'),
  ].flat();
};

/** Partitions of the archives written down as taken off the disk, that have files on it. */
const archives = async (looking: Looking): Promise<Finding[]> => {
  const { db, config, origin } = looking;

  const back = new Map<string, { key: PartitionKey; files: string[] }>();

  for (const key of record.evictionsOf(db, origin)) {
    if (back.has(idOf(key))) continue;

    const files = await looking.archives.filesOf(key);

    if (files.length > 0) back.set(idOf(key), { key, files: files.map(file => path.join(config.sourceRoot, file.path)) });
  }

  if (back.size === 0) return [];

  const asked = await asStored(looking, new Set([...back.values()].map(one => one.key.venue)));
  const same  = [...back.values()].filter(one => asked?.has(idOf(one.key)));
  const newer = [...back.values()].filter(one => ! asked?.has(idOf(one.key)));

  const writeDown = (list: readonly { key: PartitionKey }[]) => ({
    label: 'Write them down as back',
    apply: () => { for (const one of list) record.noteReturn(db, origin, one.key); },
  });

  return [
    found(`${count(same.length, 'partition')} of the archives written down as taken off the disk ${same.length === 1 ? 'has' : 'have'} files on it`,
      same.map(one => idOf(one.key)), [
        writeDown(same),
        { label: 'Remove their files from the disk again', destructive: true, apply: () => discard(same.flatMap(one => one.files), false) },
      ], 'Downloaded again, or brought back by hand: cold storage holds them at the version the catalog has, the one they were taken off at. Written down as back, `cold evict` weighs them again like any other.'),
    found(`${count(newer.length, 'partition')} of the archives written down as taken off the disk ${newer.length === 1 ? 'has' : 'have'} files on it that cold storage may not hold`,
      newer.map(one => idOf(one.key)), [writeDown(newer)], asked
        ? 'Not as cold storage holds them, or not yet where `cold evict` would take them: what is on disk may be newer than cold storage\'s copy, and the next push needs it. Written down as back, `cold evict` weighs them again like any other.'
        : 'Whether cold storage holds them as they are could not be asked: what is on disk may be newer than its copy. Written down as back, `cold evict` weighs them again like any other.'),
  ].flat();
};

/**
 * Of the partitions written down as taken off the disk, the ones `evict
 * --cleanup` would take off it again: by partition. Null where that could not
 * be asked — a catalog that is not answering is not waited for here.
 */
const asStored = async (looking: Looking, venues: ReadonlySet<string>): Promise<Set<string> | null> => {
  const { db, config, origin } = looking;
  const stocked = stockedIn(config.vaultRoot) ?? [];
  const out     = new Set<string>();

  try {
    for (const venue of venues) {
      const evicted = record.evictedOf(db, origin, venue);
      const { ready } = await catalog.once(() => survey(db, config, origin, venue, stocked, Date.now(), looking.archives));

      for (const one of ready) if (evicted.get(idOf(one)) === one.version) out.add(idOf(one));
    }
  } catch (err) {
    warn(`Whether cold storage holds what is on disk again could not be asked: ${(err as Error).message}`);

    return null;
  }

  return out;
};
