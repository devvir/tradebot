import * as record from '../../shared/record';
import { fileLabelOf, remoteOf } from '../../shared/vault/layout';
import { fmtBytes } from '../../../../shared/utils/format';
import type { StoredFile } from '../../shared/types';
import type { Tar } from '../../types';
import { are, count, found } from '../finding';
import type { Check, Finding, Looking } from '../types';

/**
 * The record against Mega: is what is written down as stored there, at the
 * size it was sent and under the identifier Mega gave it — and is everything
 * that is there written down.
 *
 * Mega is asked once for the whole tree. What it says is taken as how things
 * are: where the two disagree, it is the record that is brought round, since
 * the record is the claim and Mega the fact. The one thing offered that touches
 * Mega is removing what the record has never heard of, and that is never done
 * unasked.
 */
export const againstMega: Check = async (looking) => {
  if (! looking.remote) return [];

  const held = await looking.remote.listing(looking.config.megaRoot);

  return looking.origin === 'vault' ? vault(looking, held) : tars(looking, held);
};

// ── Internals ─────────────────────────────────────────────────────────────────

type Held = Map<string, { bytes: number; handle: string | null }>;

/** The tars of the archives. */
const tars = (looking: Looking, held: Held): Finding[] => {
  const { db, config, origin, remote } = looking;

  const all    = record.tarsOf(db, origin);
  const stored = all.filter(tar => tar.state === 'stored' || tar.state === 'stale');

  const missing = stored.filter(tar => ! held.has(tar.remote));
  const resized = stored.filter(tar => held.has(tar.remote) && held.get(tar.remote)!.bytes !== tar.bytes);
  const renamed = stored.filter(tar => held.get(tar.remote)?.bytes === tar.bytes && held.get(tar.remote)!.handle !== tar.handle);

  const known   = new Set(all.map(tar => tar.remote));
  const orphans = [...held].filter(([path]) => path.endsWith('.tar') && ! known.has(path));

  /** How many partitions of these tars are no longer on disk: what cannot be packed a second time. */
  const gone = (list: readonly Tar[]): number => {
    const evicted = new Set(record.evictionsOf(db, origin).map(one => JSON.stringify([one.venue, one.market, one.dataset, one.variant, one.grain, one.bundle, one.month])));

    return list.flatMap(tar => record.heldIn(db, tar.id))
      .filter(one => evicted.has(JSON.stringify([one.venue, one.market, one.dataset, one.variant, one.grain, one.bundle, one.month]))).length;
  };

  const again = (list: readonly Tar[]) => ({
    label: 'Write them down as not stored, so the next push packs and sends them again',
    apply: () => { for (const tar of list) record.move(db, tar.id, 'planned'); },
  });

  const lost = (list: readonly Tar[]): string | undefined => {
    const n = gone(list);

    return n > 0 ? `${n} of their partitions have been taken off the disk: those cannot be packed again from here, and cold storage was their only copy.` : undefined;
  };

  return [
    found(`${count(missing.length, 'tar')} written down as stored ${are(missing)} not in Mega`, missing.map(tar => tar.remote), [again(missing)], lost(missing)),
    found(`${count(resized.length, 'tar')} in Mega ${are(resized)} not the size that was sent`,
      resized.map(tar => `${tar.remote}: ${fmtBytes(tar.bytes ?? 0)} sent, ${fmtBytes(held.get(tar.remote)!.bytes)} there`), [again(resized)], lost(resized)),
    found(`${count(renamed.length, 'tar')} in Mega ${are(renamed)} under another identifier than the one written down`, renamed.map(tar => tar.remote), [{
      label: 'Write down the identifier Mega has now',
      apply: () => { for (const tar of renamed) record.reHandle(db, tar.id, held.get(tar.remote)!.handle); },
    }], 'The size is right, so this is the same tar sent again or moved within Mega.'),
    found(`${count(orphans.length, 'tar')} in Mega ${are(orphans)} not in the record (${fmtBytes(orphans.reduce((sum, [, one]) => sum + one.bytes, 0))})`,
      orphans.map(([path]) => path), [{
        label: 'Remove them from Mega',
        destructive: true,
        apply: async () => { for (const [path] of orphans) await remote!.remove(`${config.megaRoot}/${path}`); },
      }], 'Nothing says what they hold. A tar a replanning left behind is the usual one — and so is one a lost record no longer knows.'),
  ].flat();
};

/** The files of the vault. */
const vault = (looking: Looking, held: Held): Finding[] => {
  const { db, config, remote } = looking;

  const all = record.vaultFiles(db);

  /** Several revisions of a file are one path in Mega: what is there may be any of the ones written down as stored. */
  const stored = new Map<string, StoredFile[]>();

  for (const file of all.filter(one => one.state === 'stored')) stored.set(remoteOf(file), [...stored.get(remoteOf(file)) ?? [], file]);

  const missing: StoredFile[] = [];
  const resized: StoredFile[] = [];
  const renamed: { file: StoredFile; handle: string | null }[] = [];

  for (const [path, files] of stored) {
    const there = held.get(path);

    if (! there) missing.push(...files);
    else if (! files.some(file => file.bytes === there.bytes)) resized.push(...files);
    else if (! files.some(file => file.bytes === there.bytes && file.handle === there.handle))
      renamed.push({ file: files.find(file => file.bytes === there.bytes)!, handle: there.handle });
  }

  const known   = new Set(all.map(remoteOf));
  const orphans = [...held].filter(([path]) => path.endsWith('.parquet') && ! known.has(path));

  const again = (list: readonly StoredFile[]) => ({
    label: 'Write them down as not stored, so the next push sends them again',
    apply: () => {
      for (const file of list) {
        record.moveVaultFile(db, file, 'planned');
        record.dropVaultPartition(db, file.partition, file.revision);
      }
    },
  });

  const lost = (list: readonly StoredFile[]): string | undefined => {
    const n = list.filter(file => file.evictedAt !== null).length;

    return n > 0 ? `${n} of them have been taken off the disk: cold storage was their only copy, and they have to be stocked again.` : undefined;
  };

  const named = (list: readonly StoredFile[]): string[] => list.map(file => fileLabelOf(file.path));

  return [
    found(`${count(missing.length, 'vault file')} written down as stored ${are(missing)} not in Mega`, named(missing), [again(missing)], lost(missing)),
    found(`${count(resized.length, 'vault file')} in Mega ${are(resized)} not the size that was sent`, named(resized), [again(resized)], lost(resized)),
    found(`${count(renamed.length, 'vault file')} in Mega ${are(renamed)} under another identifier than the one written down`, named(renamed.map(one => one.file)), [{
      label: 'Write down the identifier Mega has now',
      apply: () => { for (const one of renamed) record.reHandleVaultFile(db, one.file, one.handle); },
    }], 'The size is right, so this is the same file sent again or moved within Mega.'),
    found(`${count(orphans.length, 'file')} of the vault in Mega ${are(orphans)} not in the record (${fmtBytes(orphans.reduce((sum, [, one]) => sum + one.bytes, 0))})`,
      orphans.map(([path]) => path), [{
        label: 'Remove them from Mega',
        destructive: true,
        apply: async () => { for (const [path] of orphans) await remote!.remove(`${config.megaRoot}/${path}`); },
      }], 'An instrument a month no longer has, left behind when the month was stocked again, is the usual one.'),
  ].flat();
};
