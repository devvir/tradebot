import fs from 'node:fs';
import path from 'node:path';
import { localPath, remotePath } from '../../config';
import { Archives, matches } from '../../shared/disk';
import { idOf, partitionOf } from '../../shared/keys';
import * as mega from '../../shared/mega';
import { Progress } from '../../shared/progress';
import * as record from '../../shared/record';
import { correctionOf, replaceMembers } from './correct';
import { sizedMembersOf } from '../../shared/tar';
import { tarSize, writePart } from './pack';
import { fmtBytes } from '../../../../shared/utils/format';
import type { DatabaseSync } from 'node:sqlite';
import type { ColdConfig, Origin, Tar } from '../../types';
import type { Round } from '../types';
import type { SourceFile } from '../../shared/types';

/**
 * Take one tar one step. Says whether anything moved, so a round in which
 * nothing did is one to wait after.
 */
export const step = async (
  db:       DatabaseSync,
  config:   ColdConfig,
  origin:   Origin,
  archives: Archives,
  tar:      Tar,
  progress: Progress,
  round:    Round,
): Promise<boolean> => {
  const local = localPath(config, origin, tar);

  switch (tar.state) {
    case 'planned': {
      // Packing ahead of the link only fills the disk with tars waiting to go.
      if (! await round.room()) return false;

      const held    = record.heldIn(db, tar.id);
      const members: string[] = [];
      const sized:   SourceFile[] = [];

      // Shown before the files are gathered: on a tar of small files that is minutes.
      progress.working('Checking', labelOf(tar));

      for (const one of held) {
        const files = await archives.filesOf(one);

        if (! matches(files, one)) {
          progress.worked();

          throw new Error(`${idOf(one)} is not on disk as the catalog says `
            + `(${files.length} files there, ${one.files} expected) — left for the next run`);
        }

        // Not spread: a partition can hold more files than a call takes arguments.
        for (const file of files) {
          members.push(file.path);
          sized.push(file);
        }
      }

      // Against what the tar will weigh, not what it holds: a header and padding
      // per member is most of a tar of small files, and the bar would stand at
      // 100% through most of the writing.
      progress.working('Packing', labelOf(tar), `${local}.tmp`, tarSize(sized));

      try {
        await writePart(config.sourceRoot, local, members, () => progress.verifying());
      } catch (err) {
        progress.worked();

        throw err;
      }

      const bytes = fs.statSync(local).size;

      record.packed(db, tar.id, bytes);
      progress.worked(`Packed ${labelOf(tar)} · ${fmtBytes(bytes)}`);

      // One tar a round: the queue is asked again before another is made.
      round.packed();

      return true;
    }

    case 'packed': {
      /**
       * A packed tar that is not on disk was lost between runs. What that means
       * depends on whether Mega has an older one: a tar being corrected goes
       * back to being fetched, and a new one back to being packed.
       */
      if (! fs.existsSync(local)) {
        record.move(db, tar.id, tar.handle ? 'stale' : 'planned');

        return true;
      }

      if (! (await round.uploads()).has(local))
        await mega.queueUpload(local, path.dirname(remotePath(config, tar)));

      record.move(db, tar.id, 'queued');

      return true;
    }

    case 'queued': {
      const found = await mega.remote(remotePath(config, tar));

      /**
       * **Confirmed from Mega, never from an exit code.** Mega publishes a file
       * only once it is complete, so the right size at the path is the proof —
       * and where a tar replaces an older one, a handle that is no longer the
       * older one's, since the two can weigh the same.
       */
      if (found && found.bytes === tar.bytes && (tar.handle === null || found.handle !== tar.handle)) {
        record.applyChanges(db, tar.id);
        record.stored(db, tar.id, found.handle);

        await fs.promises.rm(local, { force: true });

        progress.stored(labelOf(tar), tar.bytes ?? 0);

        return true;
      }

      // Mega dropped it from its queue without storing it: hand it over again.
      if (! (await round.uploads()).has(local)) {
        record.move(db, tar.id, 'packed');

        return true;
      }

      return false;
    }

    case 'stale': {
      await fs.promises.mkdir(path.dirname(local), { recursive: true });
      await fs.promises.rm(local, { force: true });
      await mega.queueDownload(remotePath(config, tar), path.dirname(local));

      record.move(db, tar.id, 'fetching');

      progress.log(`Bringing ${labelOf(tar)} back to correct it · ${fmtBytes(tar.bytes ?? 0)}`);

      return true;
    }

    case 'fetching': {
      const here = fs.existsSync(local) ? fs.statSync(local).size : -1;

      if (here === tar.bytes && ! (await round.downloads()).has(local)) {
        record.move(db, tar.id, 'fetched');

        return true;
      }

      // Mega dropped it from its queue without finishing: ask for it again.
      if (! (await round.downloads()).has(local)) {
        record.move(db, tar.id, 'stale');

        return true;
      }

      return false;
    }

    case 'fetched': {
      const changed = record.heldIn(db, tar.id).filter(one => one.next !== null);
      const stale   = new Set(changed.map(idOf));
      const add: string[] = [];

      const remove: string[] = [];

      /** What the tar holds of each partition that changed. */
      const inTar = new Map<string, SourceFile[]>();

      for (const member of await sizedMembersOf(local)) {
        const key = partitionOf(member.path);

        if (key !== null && stale.has(idOf(key))) inTar.set(idOf(key), [...inTar.get(idOf(key)) ?? [], member]);
      }

      /**
       * **From the disk, or from the disk and the tar together.** A partition
       * that was taken off the disk after it was stored is here only in the
       * files that changed; the tar just brought back has the rest. See
       * `correctionOf`.
       */
      for (const one of changed) {
        const fix = correctionOf(inTar.get(idOf(one)) ?? [], await archives.filesOf(one), one.next!);

        if (! fix)
          throw new Error(`${idOf(one)} is not on disk as the catalog says, and what is on disk does not complete `
            + 'what the tar holds of it — left for the next run');

        remove.push(...fix.remove);
        add.push(...fix.add);
      }

      progress.working('Correcting', labelOf(tar));

      try {
        await replaceMembers(config.sourceRoot, local, remove, add);
      } catch (err) {
        progress.worked();

        throw err;
      }

      record.packed(db, tar.id, fs.statSync(local).size);
      progress.worked(`Corrected ${labelOf(tar)} · ${changed.length} partition${changed.length === 1 ? '' : 's'} · `
        + `${remove.length} files out, ${add.length} in`);

      return true;
    }

    default:
      return false;
  }
};

export const labelOf = (tar: Tar): string => `${tar.venue}/${path.basename(tar.local)}`;
