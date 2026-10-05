import fs from 'node:fs';
import path from 'node:path';
import { GB, POLL_MS, loadConfig, localPath, remotePath } from './config';
import { plannerFor } from './planners';
import { acquire } from './lock';
import { clearTemporary, tarSize, verifyPart, writePart } from './tar';
import { onExit } from './cleanup';
import { Progress } from './progress';
import { fmtBytes } from '../../shared/utils/format';
import * as db from './db';
import * as mega from './mega';
import { error, info, spacer, success, warn } from '../../shared/ui/logger';
import { confirm } from '../../shared/ui/prompts';
import type { DatabaseSync } from 'node:sqlite';
import type { ColdConfig, Origin, PartRow, SourceFile } from './types';

/**
 * Pack what is not in cold storage yet, and upload it.
 *
 * The shape of the run is dictated by the link: at a few megabits, uploading is
 * hours per tar while packing one is minutes. So this does **not** pack
 * everything and then upload it — that would fill the disk with terabytes of
 * tars waiting on a week of bandwidth. It keeps just enough packed to keep the
 * queue fed, and stops packing while the queue is deep enough.
 *
 * Every step is resumable, because a run that takes a week will be interrupted.
 * Plans are written before tars exist, tars are proved before being uploaded,
 * and an upload is confirmed from Mega rather than from an exit code — so a
 * second run picks up wherever the first stopped without redoing the expensive
 * part.
 */
export const runPush = async (origin: Origin, venues: string[] = []): Promise<void> => {
  const config  = loadConfig(origin);
  const release = await acquire(config.coldRoot, origin, 'push');

  try {
    if (! await mega.available()) {
      error('mega-cmd is not available — is the session logged in?');

      return;
    }

    const handle = db.open(config.dbPath);

    // Also on the signal path: `process.exit` in a handler skips every pending
    // `finally`, so a Ctrl-C would otherwise leave the handle open.
    onExit(() => db.close(handle));

    try {
      const swept = await clearTemporary(path.join(config.coldRoot, origin));

      if (swept > 0) info(`Cleared ${swept} unfinished tar${swept === 1 ? '' : 's'} from a previous run`);

      /**
       * One listing of the whole origin, taken before anything is decided.
       *
       * Both guards below need to know what Mega already holds, and asking per
       * part would be hundreds of round trips for a question one recursive
       * listing answers.
       */
      const remote = await mega.listing(`${config.megaRoot}`);

      resolveSuperseded(handle, origin, remote);

      const withheld = await planPending(handle, config, origin, remote, venues);

      /**
       * **Before the work, not only after it.** A month whose replacements are
       * already in Mega is ready to be tidied now, and gating that on the rest
       * of the backlog means an operator waits days to clean up something that
       * finished last night. Run again at the end for whatever became ready
       * during this pass.
       */
      await askAboutGhosts(handle, origin, venues);
      await sweepGhosts(handle, config, origin, venues);

      const parts = only(db.outstanding(handle, origin), venues);

      if (parts.length === 0) {
        /**
         * **A run that withheld months has not finished the job**, and must not
         * close by saying everything is backed up — that sentence would undo
         * the refusal it is printed directly beneath. Said as a state rather
         * than a success, since nothing here can fix it.
         */
        if (withheld > 0)
          info(`Nothing to push — ${withheld} month${withheld === 1 ? '' : 's'} `
            + `withheld above, and nothing else is outstanding`);
        else
          success(venues.length > 0
            ? `Everything from ${venues.join(', ')} is in cold storage — nothing to push`
            : 'Everything is in cold storage — nothing to push');

        return;
      }

      if (! await approve(parts, config)) return;

      await work(handle, config, origin, parts, remote, venues);

      await sweepGhosts(handle, config, origin);
    } finally {
      db.close(handle);
    }
  } finally {
    release();
  }
};

// ── Internals ─────────────────────────────────────────────────────────────────

/**
 * Keep only the rows belonging to the venues asked for; everything when none was.
 *
 * For rows already in the record. The **scan** is narrowed by the planner
 * itself, which is the only place it can be done in time to matter: filtering
 * afterwards has already walked millions of entries for a venue nobody asked
 * about, and has already reported on it.
 */
const only = <T extends { venue: string }>(rows: T[], venues: string[]): T[] =>
  (venues.length === 0 ? rows : rows.filter(row => venues.includes(row.venue)));

/**
 * Settle descriptions left over from a replacement nobody saw finish.
 *
 * A run that is stopped mid-upload never observes its own success: Mega
 * completes the transfer, and the record still says an older object is there
 * with a description waiting to be compared against. The next start is where
 * that gets noticed.
 *
 * The size Mega reports decides it, since a member list predicts a tar's bytes
 * exactly:
 *
 * - **nothing at the path** — the object is gone, so there is nothing to
 *   protect and nothing to compare. Forget it.
 * - **the size the old description implies** — the replacement never landed.
 *   Keep it; the part will be packed and offered again.
 * - **anything else** — the replacement landed, or something else did. Either
 *   way the description no longer matches what is there, so it cannot guard a
 *   comparison. Forget it, and say so.
 */
const resolveSuperseded = (
  handle: DatabaseSync,
  origin: Origin,
  remote: Map<string, { bytes: number; handle: string | null }>,
): void => {
  let resolved = 0;

  for (const path of db.supersededPaths(handle, origin)) {
    const held = remote.get(path);
    const was  = [...db.supersededAt(handle, origin, path).values()];

    if (held && tarSize(was) === held.bytes) continue;

    db.resolveSuperseded(handle, origin, path);

    resolved++;
  }

  if (resolved > 0)
    info(`${resolved} superseded description${resolved === 1 ? '' : 's'} settled — `
      + 'their objects have been replaced or removed');
};

/**
 * Turn whatever the source tree holds that cold storage does not into planned
 * parts.
 *
 * **Only finding the work differs between trees; recording it does not.** The
 * planner says which venue-months hold files that are not backed up and how to
 * divide them, and everything below — the part names, the remote layout, the
 * rows, the sequence numbers — is the same operation for every origin.
 */
const planPending = async (
  handle: DatabaseSync,
  config: ColdConfig,
  origin: Origin,
  remote: Map<string, { bytes: number; handle: string | null }>,
  venues: string[],
): Promise<number> => {
  const planner = plannerFor(origin);

  let dropped = 0;

  /**
   * **A plan nobody has acted on yet is worth nothing, so it is thrown away.**
   *
   * It described the tree as it was when it was made, and files move between
   * disks, get rebuilt by the producer, or go away — after which a tar built
   * from that list either fails on a path that is no longer there or captures
   * something the row does not describe.
   *
   * Rather than work out which plans drifted, every part that has not been
   * packed is discarded and planned again from what is on disk now. Planning is
   * cheap next to uploading: the scan happens either way, and the rest is a
   * hash-map diff and a sort. What is kept is what already cost something — a
   * part with a tar, or one already in cold storage.
   *
   * **Its month gate goes with it.** A planner that skips settled months would
   * otherwise be left remembering that it had examined this one, having just
   * had the result of that examination thrown away — and the month would never
   * be looked at again.
   */
  for (const part of only(db.outstanding(handle, origin), venues)) {
    if (fs.existsSync(localPath(config, origin, part))) continue;

    /**
     * **Before the description goes, find out whether it describes anything.**
     *
     * A dropped plan takes its member list with it, and that list is the only
     * record of what Mega holds at that path. Replacing the object later would
     * then be a blind commitment — no way to tell an update that adds files
     * from one that loses them.
     *
     * Kept in the database rather than for the run, so an interruption between
     * here and the upload cannot leave the object undescribed.
     */
    const held = remote.get(part.remote);

    if (held) db.supersede(handle, origin, part.remote, db.membersWith(handle, part.id));

    db.dropPart(handle, part.id);
    db.forgetMonth(handle, origin, part.venue, part.month);

    dropped++;
  }

  if (dropped > 0)
    info(`Discarded ${dropped} unpacked plan${dropped === 1 ? '' : 's'} — replanning from the tree as it is now`);

  const plan = await planner.pending(handle, config, venues);

  // Already narrowed: the planner honours the venue filter, which is the only
  // place doing so saves the scan rather than just the planning.
  for (const group of plan.groups) {
    const { venue, month } = group;

    /**
     * **Two kinds of pending work, and they must not be recorded the same way.**
     *
     * A month whose pending files are all new paths is growing: the new tar
     * holds nothing any other tar holds, so it appends as the next part and
     * every object already in Mega stays exactly as it is.
     *
     * A month with a pending file that some part already holds is being
     * *updated* — the producer rebuilt a partition under the same path. Appending
     * there would leave the old copy in cold storage beside the new one, which
     * is how one partition came to sit in three tars with three different sizes
     * and nothing saying which was current. Such a month is replanned whole and
     * written back over the names it already occupies, so Mega replaces rather
     * than accumulates.
     */
    const known = db.packedIn(handle, origin, venue, month);

    if (group.files.some(file => known.has(file.path))) {
      if (await replanMonth(handle, config, origin, group, remote)
        && group.closedAt !== null) db.rememberMonth(handle, origin, venue, month, group.closedAt);

      continue;
    }

    for (const bin of planner.pack(group.files, config.capBytes)) {
      const seq   = db.nextSeq(handle, origin, venue, month);
      const name  = `${month}.p${String(seq).padStart(2, '0')}.tar`;
      const bytes = bin.reduce((total, file) => total + file.bytes, 0);

      db.plan(handle, {
        origin, venue, month, seq, name, bytes, files: bin.length,
        remote: `${venue}/${month.slice(0, 4)}/${name}`,
        local:  path.join(venue, name),
      }, bin);
    }

    /**
     * Written last, once every part of the month is recorded, so a crash
     * part-way through leaves the gate open rather than closed over a month
     * that was only half planned. A tree with no such signal returns null and
     * gets no row.
     */
    if (group.closedAt !== null) db.rememberMonth(handle, origin, venue, month, group.closedAt);
  }

  return plan.withheld;
};

/**
 * Replan a whole venue-month whose members have already been packed.
 *
 * **The month is the unit, because the part is not.** Bin packing places a
 * symbol wherever it fits, so which tar holds a member is an accident of the
 * last plan — repack and a symbol moves from `p01` to `p02` having lost nothing.
 * The only question worth asking is therefore asked across the month: is
 * everything the month held still here? Asking it per part reports every such
 * move as a loss.
 *
 * What it packs is every member the month already had, restated from disk, plus
 * the pending files on top. Parts are then written back over `p01…pN`, so an
 * upload replaces each object under the name it already has rather than adding
 * another beside it.
 *
 * **A member whose file is gone cannot be repacked, and that is the one case
 * that stops.** It would silently drop out of the new tars while the old ones
 * that held it are overwritten — cold storage losing data by being updated.
 *
 * **It is refused rather than asked about**, because there is no answer worth
 * offering: agreeing costs the only copy of those files, and the run has no way
 * to make the alternative true. What the month actually needs is its evicted
 * members pulled back from Mega before it is repacked, which is a restore this
 * command cannot yet perform — so it is named and left alone, and the rest of
 * the run carries on. See [COLD-PUSH.md](COLD-PUSH.md).
 *
 * Returns whether the month was replanned.
 */
const replanMonth = async (
  handle: DatabaseSync,
  config: ColdConfig,
  origin: Origin,
  group:  { venue: string; month: string; files: SourceFile[] },
  remote: Map<string, { bytes: number; handle: string | null }>,
): Promise<boolean> => {
  const { venue, month } = group;
  const planner = plannerFor(origin);
  const existing = db.partsIn(handle, origin, venue, month);

  /** Every member the month holds now, keyed by path so the pending files win. */
  const files = new Map<string, SourceFile>();

  const lost: string[] = [];

  for (const member of db.monthMembers(handle, origin, venue, month)) {
    const stat = statOf(path.join(config.sourceRoot, member.path));

    if (! stat) { lost.push(member.path); continue; }

    files.set(member.path, { ...member, bytes: stat.bytes, mtime: stat.mtime });
  }

  for (const file of group.files) files.set(file.path, file);

  if (lost.length > 0) {
    spacer();
    warn(`${venue}/${month} — cannot be repacked: cold storage holds ${lost.length} file`
      + `${lost.length === 1 ? '' : 's'} disk no longer does:`);

    for (const file of lost.slice(0, 5)) info(`    ${file}`);

    if (lost.length > 5) info(`    … and ${lost.length - 5} more`);

    spacer();
    info(`Something in this month was rebuilt, so the whole month must be written back — `
      + `and those files cannot be restated from disk. Restore ${venue}/${month} from Mega, `
      + `then push again.`);
    info(`${venue}/${month} left as it is; the rest of the run continues.`);

    return false;
  }

  const bins = planner.pack([...files.values()], config.capBytes);

  /**
   * The old rows go before the new ones are written, so the month never holds
   * two plans at once — and each object Mega still has is described first, since
   * dropping the row is what makes that list unrecoverable.
   */
  for (const part of existing) {
    if (remote.has(part.remote)) db.supersede(handle, origin, part.remote, db.membersWith(handle, part.id));

    db.dropPart(handle, part.id);
  }

  bins.forEach((bin, index) => {
    const seq   = index + 1;
    const name  = `${month}.p${String(seq).padStart(2, '0')}.tar`;
    const bytes = bin.reduce((total, file) => total + file.bytes, 0);

    db.plan(handle, {
      origin, venue, month, seq, name, bytes, files: bin.length,
      remote: `${venue}/${month.slice(0, 4)}/${name}`,
      local:  path.join(venue, name),
    }, bin, true);
  });

  /**
   * **A month that shrinks leaves objects behind.** Three parts replanned into
   * two means the third still sits in Mega holding members that now live in the
   * other two — the copy nobody should ever read. It is recorded rather than
   * deleted: nothing goes until the replacements are confirmed uploaded, and
   * then only if somebody says so.
   */
  for (const part of existing.filter(row => row.seq > bins.length))
    db.markGhost(handle, origin, venue, month, part.remote);

  info(`Replanned ${venue}/${month} — ${existing.length} part${existing.length === 1 ? '' : 's'} `
    + `→ ${bins.length}, ${files.size.toLocaleString()} files`);

  return true;
};

/** Size and mtime of a source file, or null when it is no longer there. */
const statOf = (absolute: string): { bytes: number; mtime: number } | null => {
  try {
    const stat = fs.statSync(absolute);

    return { bytes: stat.size, mtime: Math.floor(stat.mtimeMs) };
  } catch {
    return null;
  }
};

/**
 * Ask once, up front, whether the objects a replan orphaned may go.
 *
 * **Permission is given before the work, not earned after it.** An orphan is
 * only safe to remove once its replacements are confirmed in Mega, and on a
 * backfill that is weeks away — so asking at that moment is asking nobody, since
 * the whole point of a long run is that it is left alone. The decision is taken
 * while somebody is still watching and recorded, and the deletions then happen
 * unattended as each month completes.
 *
 * Declining is remembered as "not yet" rather than "never": the objects stay,
 * and the next run asks again.
 */
const askAboutGhosts = async (
  handle: DatabaseSync,
  origin: Origin,
  venues: string[],
): Promise<void> => {
  const pending = only(db.unapprovedGhosts(handle, origin), venues);

  if (pending.length === 0) return;

  spacer();
  warn(`${pending.length} object${pending.length === 1 ? '' : 's'} in Mega `
    + `${pending.length === 1 ? 'is' : 'are'} left over from replanning: `
    + `${pending.length === 1 ? 'it holds' : 'they hold'} nothing that is not now in another tar.`);

  for (const ghost of pending.slice(0, 10)) info(`    ${ghost.venue}/${ghost.month} — ${ghost.remote}`);

  if (pending.length > 10) info(`    … and ${pending.length - 10} more`);

  spacer();
  info('Each goes only once every part of its own month is confirmed in Mega.');

  if (! await confirm(`Delete ${pending.length === 1 ? 'it' : 'them'} as that happens?`, false)) {
    info('Left in place — the next run will ask again');

    return;
  }

  db.approveGhosts(handle, origin, venues);
};

/**
 * Remove the approved orphans whose month is now wholly in Mega.
 *
 * Called wherever a part has just been confirmed, so an object goes as soon as
 * what replaced it has landed rather than at the end of a run that may have days
 * left in it. Silent when there is nothing to do, which is almost always.
 */
const sweepGhosts = async (
  handle: DatabaseSync,
  config: ColdConfig,
  origin: Origin,
  venues: string[] = [],
): Promise<void> => {
  for (const ghost of only(db.removableGhosts(handle, origin), venues)) {
    try {
      await mega.remove(`${config.megaRoot}/${ghost.remote}`);
      db.forgetGhost(handle, origin, ghost.remote);

      /**
       * The description goes with the object. It existed to say what would be
       * overwritten at that path, and nothing is at that path now — left behind
       * it is a record of something that no longer exists, which reads for ever
       * as a replacement still outstanding.
       */
      db.resolveSuperseded(handle, origin, ghost.remote);

      info(`${ghost.venue}/${ghost.month} — removed ${ghost.remote.split('/').pop()}, `
        + 'replaced and no longer described');
    } catch (err) {
      error(`${ghost.remote}: ${(err as Error).message}`);
    }
  }
};

const approve = async (parts: PartRow[], config: ColdConfig): Promise<boolean> => {
  const bytes  = parts.reduce((total, part) => total + part.bytes, 0);
  const venues = new Set(parts.map(part => part.venue));

  spacer();
  info(`${parts.length} part${parts.length === 1 ? '' : 's'} to upload · `
    + `${fmtBytes(bytes)} · ${venues.size} venue${venues.size === 1 ? '' : 's'} · `
    + `cap ${fmtBytes(config.capBytes)} per part`);
  spacer();

  return confirm('Pack and upload these?', true);
};

/**
 * Pack, hand to Mega, confirm, delete — one part at a time, paced by the queue.
 *
 * Packing waits on the queue rather than on the upload of any particular tar,
 * so a single huge symbol never stalls the pipeline: the moment Mega takes it,
 * it stops counting as work waiting to be sent and the packer runs ahead again.
 */
const work = async (
  handle: DatabaseSync,
  config: ColdConfig,
  origin: Origin,
  parts:  PartRow[],
  remote: Map<string, { bytes: number; handle: string | null }>,
  venues: string[],
): Promise<void> => {
  let packed = 0;
  let failed = 0;
  let held   = 0;

  const progress = new Progress(parts.length);

  onExit(() => progress.stop());

  /**
   * **Recovery first, then steady state.** A run that does not start fresh finds
   * tars from the last one, and every one of them is resolved before anything
   * new is made: a tar is valid or it is removed, sent if Mega does not have it,
   * and settled if Mega does. Once that is done there is nothing left but the
   * ordinary question — is there room to make another one.
   *
   * It belongs up front rather than interleaved because none of it costs space
   * or link time it has not already cost, and because a tar can only be here if
   * an earlier run left it. Interleaved, a new tar could be built — minutes and
   * gigabytes — while a finished one sat beside it unqueued.
   */
  failed += await recover(handle, config, origin);

  // Whatever recovery found already in Mega is confirmed and reclaimed now, so
  // the first capacity check sees the disk as it really is.
  await settle(handle, config, origin, parts, remote);

  // Re-read after recovery: it may have retracted a claim, settled a part, or
  // discarded a tar, and each of those changes what is left to do.
  progress.start();

  /**
   * **Re-read, but through the same filter it was approved under.** Recovery may
   * have retracted a claim, settled a part or discarded a tar, so the list has to
   * be taken again — and taking it unfiltered silently widened a run the operator
   * had scoped to one venue, packing everything outstanding after a prompt that
   * named a fraction of it.
   */
  const remaining = only(db.outstanding(handle, origin), venues);
  const toPack    = remaining.filter(part => ! fs.existsSync(localPath(config, origin, part)));

  parts.length = 0;
  parts.push(...remaining);

  for (const [index, part] of toPack.entries()) {
    /**
     * **One part failing does not end the run.** This is left going overnight
     * against a week of uploading, and the producer is writing to the same tree
     * while it runs — a partition rebuilt between packing a tar and verifying
     * it would otherwise abandon every part behind it. The part keeps its plan
     * and its turn comes round on the next run.
     */
    try {
      await waitForCapacity(handle, config, origin, parts, progress, remote);

      progress.log(`[${index + 1}/${toPack.length}] Packing ${labelOf(part)} · `
        + `${fmtBytes(part.bytes)} · ${part.files} file${part.files === 1 ? '' : 's'}`);
      progress.packingNow(labelOf(part));

      await writePart(config.sourceRoot, localPath(config, origin, part), db.membersOf(handle, part.id));

      packed++;

      if (! await allowed(handle, origin, part, remote, progress)) {
        held++;

        continue;
      }

      await mega.queueUpload(localPath(config, origin, part), path.dirname(remotePath(config, part)));
    } catch (err) {
      progress.log(`${labelOf(part)}: ${(err as Error).message}`);

      failed++;
    } finally {
      progress.packingNow(null);
    }

    await settle(handle, config, origin, parts, remote);

    progress.settled(parts.filter(part => part.uploadedAt).length, failed);
  }

  if (failed > 0)
    warn(`${failed} part${failed === 1 ? '' : 's'} could not be packed or queued — they keep `
      + 'their plan and will be tried again on the next run');

  if (held > 0)
    warn(`${held} part${held === 1 ? '' : 's'} were packed but not sent — replacing what Mega `
      + 'holds was declined. Run `tools cold audit` to see what differs');

  progress.log('All parts packed and queued — waiting for the uploads to finish');

  await drain(handle, config, origin, parts, progress, remote);

  progress.stop();

  const done = db.totals(handle, origin);

  spacer();
  success(`Packed ${packed}, uploaded ${done.uploaded}/${done.parts} parts · `
    + `${fmtBytes(done.uploadedBytes)} in cold storage`);
};

/**
 * Whether this tar may replace what Mega already holds at its path.
 *
 * **Overwriting is deleting and adding in one step**, so it carries the risk of
 * a delete: if the new tar is missing anything the old one had, that data
 * leaves cold storage. Which is why the question is asked from the *data* and
 * not from the record — the record says what was packed, never what was
 * removed afterwards.
 *
 * Three answers, and only one of them is silent:
 *
 * - **Nothing at that path.** Not an overwrite at all. Uploads without comment,
 *   which is what makes deleting a bad object in Mega a way to have the next run
 *   simply rebuild it.
 * - **Every old member still present and unchanged.** An update that only adds.
 *   Said out loud and proceeds — the newest tar replaces the oldest, and it may
 *   be larger or smaller depending on what changed around it.
 * - **An old member removed or changed.** Data would leave cold storage. Named,
 *   and asked, defaulting to no.
 */
const allowed = async (
  handle:   DatabaseSync,
  origin:   Origin,
  part:     PartRow,
  remote:   Map<string, { bytes: number; handle: string | null }>,
  progress: Progress,
): Promise<boolean> => {
  if (! remote.has(part.remote)) return true;

  /**
   * **A replanned month was judged whole, and must not be judged again here.**
   *
   * Its parts were packed together from every member the month had, so bin
   * packing is free to move a symbol from `p01` to `p02`. Comparing `p01`
   * against what `p01` used to hold then reports that symbol as lost, which is
   * false and — worse — is a prompt the operator learns to answer yes to. The
   * question was already asked across the month, where it has an answer.
   */
  if (part.replan) return true;

  const was = db.supersededAt(handle, origin, part.remote);

  if (was.size === 0) {
    progress.log(`${labelOf(part)} — Mega holds an object here and nothing describes it`);

    return confirm(`Replace it with the tar just packed?`, false);
  }

  const now = new Map(db.membersWith(handle, part.id).map(row => [row.path, row]));
  const { lost, moved, added } = compare(was, now);

  if (lost.length === 0 && moved.length === 0) {
    progress.log(`${labelOf(part)} — replacing what Mega holds, ${added.length} file`
      + `${added.length === 1 ? '' : 's'} added, nothing lost`);

    return true;
  }

  progress.log(`${labelOf(part)} — replacing this would lose data from cold storage:`);

  for (const file of lost.slice(0, 5))  progress.log(`    gone:    ${file}`);
  for (const file of moved.slice(0, 5)) progress.log(`    changed: ${file}`);

  if (lost.length + moved.length > 10)
    progress.log(`    … and ${lost.length + moved.length - 10} more`);

  return confirm(`Replace it anyway, losing ${lost.length} and changing ${moved.length}?`, false);
};

/**
 * What a replacement would do to the object it lands on.
 *
 * **Membership, not size.** A smaller tar is not evidence of loss — files are
 * repacked, compressed differently, redistributed between bins — and a larger
 * one is not evidence of safety. The only question that matters is whether
 * everything the old object held is still here, unchanged.
 */
const compare = (
  was: Map<string, { bytes: number; mtime: number }>,
  now: Map<string, { bytes: number; mtime: number }>,
): { lost: string[]; moved: string[]; added: string[] } => ({
  lost:  [...was.keys()].filter(file => ! now.has(file)),

  moved: [...was.entries()]
    .filter(([file, before]) => {
      const after = now.get(file);

      return Boolean(after) && (after!.bytes !== before.bytes || after!.mtime !== before.mtime);
    })
    .map(([file]) => file),

  added: [...now.keys()].filter(file => ! was.has(file)),
});

/**
 * Hold until there is room to make another tar.
 *
 * **Two backlogs, and either one full is a reason to stop.** What Mega still has
 * to send says whether the link is busy; what is staged on disk says whether the
 * buffer is full. They are not the same number — a tar Mega has finished is
 * still on disk until the next `settle` confirms and removes it, and a queue
 * shared with another origin can be deep while nothing of ours is staged at all.
 *
 * **There is no warming phase.** Filling the buffer and finding it already full
 * are the same question asked at the same point, so this is checked before every
 * part rather than only before one that needs packing — otherwise a run resuming
 * onto a pile of packed tars sails past both limits without ever asking.
 *
 * **The target keeps its GB, the measurement does not.** `COLD_QUEUE_TARGET_GB`
 * is set in gigabytes, so the threshold is printed in gigabytes and the number
 * in the log is the number in the environment. What is staged against it scales
 * to its own size, because a run pauses on a few hundred megabytes as readily as
 * on ten gigabytes and `0.3GB` says less than `312.4MB`.
 *
 * **What fills the buffer and what drains it have to be the same set.** The
 * staged total is measured from the directory, which holds every venue's tars;
 * `settle` works from this run's parts, which are filtered to the venues asked
 * for. So both run here — anything else lets a tar count against the buffer that
 * nothing in the run is able to remove, and the wait blocks on a condition it
 * cannot reach.
 */
const waitForCapacity = async (
  handle:   DatabaseSync,
  config:   ColdConfig,
  origin:   Origin,
  parts:    PartRow[],
  progress: Progress,
  remote:   Map<string, { bytes: number; handle: string | null }>,
): Promise<void> => {
  const target = config.queueTargetGb * GB;

  for (;;) {
    /**
     * **Confirming is what makes room, so it has to happen inside the wait.**
     *
     * A staged tar is deleted only once Mega is known to hold it, so `settle` is
     * the one thing that reduces the staged total. Left outside this loop — run
     * only after a part is packed — the wait blocks on a condition nothing can
     * satisfy: uploads finish, the queue drains to nothing, and the tars sit on
     * disk unconfirmed for ever.
     */
    const settled   = await settle(handle, config, origin, parts, remote);
    const reclaimed = await reclaimStaged(handle, config, origin, parts);

    // Unfiltered on purpose: only an *approved* orphan is ever removed, and
    // approval was scoped to what the operator was shown.
    if (settled + reclaimed > 0) await sweepGhosts(handle, config, origin);

    const queued = await mega.queue();
    const staged = stagedBytes(path.join(config.coldRoot, origin));

    if (queued.remaining < target && staged < target) return;

    progress.packingNow(`waiting — ${fmtBytes(staged)} staged, under ${config.queueTargetGb}GB to resume`);

    await sleep(POLL_MS);
  }
};

/**
 * Tars written and not yet confirmed in cold storage.
 *
 * A tar is removed only once Mega is known to hold it, so what is left on disk
 * *is* the buffer — whether Mega has been told about it, is sending it, or has
 * finished and simply has not been asked yet.
 */
const stagedBytes = (root: string): number =>
  stagedTars(root).reduce((total, file) => total + fs.statSync(file).size, 0);

/**
 * How a part is named in output.
 *
 * **The name alone is ambiguous.** It carries the month and the part number and
 * nothing else, so every venue produces a `201901.p01.tar` and a log of a run
 * that spans venues reads as though it were packing the same tar repeatedly.
 * The venue is the directory it sits in, both locally and in Mega, so the path
 * it is filed under is what identifies it.
 */
const labelOf = (part: PartRow): string => `${part.venue}/${part.name}`;

/**
 * Settle every tar an earlier run left behind, whatever the database says.
 *
 * **This walks the directory, not the plans.** A tar on disk is a fact; the row
 * that ought to describe it may be missing, may be for a plan that was dropped,
 * or may already claim the part is in cold storage. Iterating plans instead
 * leaves anything the plans do not mention permanently invisible — and because
 * the staged total *is* measured from the directory, an invisible tar counts
 * against the buffer for ever and eventually pauses the run for good.
 *
 * That is not hypothetical: five tars marked uploaded but never deleted held
 * 6.4 GB that nothing could ever have reclaimed.
 *
 * Every tar leaves here sent, gone, or already travelling:
 *
 * | on disk | recorded | in Mega | outcome |
 * |---|---|---|---|
 * | yes | — | in the queue | already on its way: left alone |
 * | yes | uploaded | yes | local copy reclaimed |
 * | yes | uploaded | no | the claim was wrong: retracted, and queued |
 * | yes | outstanding | yes | recorded and reclaimed |
 * | yes | outstanding | no | verified, then queued |
 * | yes | nothing | — | orphan: nothing can say what is in it, so deleted |
 *
 * **The queue is asked before Mega, because that is the direction a transfer
 * travels.** Asking Mega first leaves a window: a tar still uploading is absent
 * from Mega, and by the time the queue is read it has finished and left — so
 * both answers are "no" and it is sent a second time.
 *
 * **A tar left travelling is not a tar left behind.** It is still staged, still
 * counted against the buffer, and still owed a confirmation — which it gets from
 * `reclaimStaged` on the next capacity check rather than here, because the
 * transfer that has to finish first outlives this loop by hours. Resolving it
 * here would mean waiting on an upload before packing anything at all.
 */
const recover = async (
  handle: DatabaseSync,
  config: ColdConfig,
  origin: Origin,
): Promise<number> => {
  const root   = path.join(config.coldRoot, origin);
  const staged = stagedTars(root);

  if (staged.length === 0) return 0;

  info(`${staged.length} tar${staged.length === 1 ? '' : 's'} left by an earlier run — `
    + 'resolving them before making more');

  // Asked once: the set only shrinks while this loop runs, and a tar it does not
  // mention is one nothing else is carrying.
  const carrying = await mega.queuedPaths();

  let failed = 0;

  for (const [index, local] of staged.entries()) {
    const at = `[${index + 1}/${staged.length}]`;

    // Relative to the origin root rather than a basename, so the venue is in
    // the line — a part's name carries only the month, and several venues
    // produce `201901.p01.tar`.
    const name = path.relative(root, local);

    try {
      const part = db.partByLocal(handle, origin, path.relative(root, local));

      if (! part) {
        fs.rmSync(local, { force: true });

        warn(`${at} ${name} — no plan describes it, discarded`);

        continue;
      }

      if (carrying.has(local)) {
        info(`${at} ${name} — already on its way`);

        continue;
      }

      const found = await mega.remote(remotePath(config, part));
      const size  = fs.statSync(local).size;

      if (found && found.bytes === size) {
        if (! part.uploadedAt) db.markUploaded(handle, part.id, found.handle);

        fs.rmSync(local, { force: true });

        info(`${at} ${name} — in cold storage, local copy reclaimed`);

        continue;
      }

      if (part.uploadedAt) {
        db.clearUploaded(handle, part.id);

        warn(`${at} ${name} — recorded as backed up but Mega does not hold it; retracting that`);
      }

      if (! await verifyPart(config.sourceRoot, local, db.membersOf(handle, part.id))) {
        fs.rmSync(local, { force: true });

        warn(`${at} ${name} — does not match the vault, discarded and will be packed again`);

        continue;
      }

      await mega.queueUpload(local, path.dirname(remotePath(config, part)));

      info(`${at} ${name} — verified, queued`);
    } catch (err) {
      error(`${name}: ${(err as Error).message}`);

      failed++;
    }
  }

  return failed;
};

/** Every `.tar` staged under an origin, which is the ground truth recovery works from. */
const stagedTars = (root: string): string[] => {
  const found: string[] = [];

  const sweep = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);

      if (entry.isDirectory()) sweep(full);
      else if (entry.name.endsWith('.tar')) found.push(full);
    }
  };

  try {
    sweep(root);
  } catch {
    // Nothing staged yet.
  }

  return found.sort();
};

/**
 * Record whatever has finished uploading, and reclaim its tar.
 *
 * Confirmed from Mega's own listing rather than from `mega-put`'s exit code:
 * the file is published only once it is whole, so its presence at the right
 * size is the proof. The handle is kept alongside, since it identifies the
 * stored object independently of the path it was written to.
 */
/** Paths already reported as holding something unplanned, so it is said once. */
const reported = new Set<string>();

const settle = async (
  handle: DatabaseSync,
  config: ColdConfig,
  origin: Origin,
  parts:  PartRow[],
  remote: Map<string, { bytes: number; handle: string | null }>,
): Promise<number> => {
  let settled = 0;

  for (const part of parts) {
    if (part.uploadedAt || ! fs.existsSync(localPath(config, origin, part))) continue;

    const found = await mega.remote(remotePath(config, part));

    if (! found) continue;

    const local = fs.statSync(localPath(config, origin, part)).size;

    if (found.bytes !== local) {
      /**
       * **A replacement that has not landed yet is not a discrepancy.** This
       * runs after every pack, so a part whose tar is queued to overwrite an
       * existing object finds that object still in place every time round — the
       * old size, exactly as the listing taken at startup recorded it. That is
       * the upload being unfinished, which is the ordinary state of an upload.
       *
       * Only a *third* size means something nobody planned is at that path, and
       * that is worth one line. Said once per part rather than once per pass,
       * since the condition persists until the upload lands and repeating it
       * buries everything else.
       */
      if (found.bytes !== remote.get(part.remote)?.bytes && ! reported.has(part.remote)) {
        reported.add(part.remote);

        warn(`${labelOf(part)}: Mega holds ${fmtBytes(found.bytes)}, which is neither `
          + `the ${fmtBytes(local)} packed here nor what was there at the start`);
      }

      continue;
    }

    db.markUploaded(handle, part.id, found.handle);
    fs.rmSync(localPath(config, origin, part), { force: true });

    part.uploadedAt = new Date().toISOString();
    settled++;
  }

  return settled;
};

/**
 * Reclaim every staged tar Mega already holds, whichever plan made it.
 *
 * `settle` asks the run's own parts, and those are narrower than the disk in two
 * ways: they are filtered to the venues asked for, and a part already recorded
 * as backed up is not among them. The buffer that decides whether to pack is
 * measured from the directory, which knows neither restriction — so a tar
 * outside the run's plans counts against the buffer and nothing in the run can
 * take it away.
 *
 * That deadlocked a real run. `cold push vault kucoin` found seven binance tars
 * an earlier run had left in flight, reported them as already on their way, and
 * carried on. Their uploads finished; no kucoin part described them; they held
 * 11.7GB against a 10GB target with nothing queued and nothing packing, and only
 * a restart could clear them.
 *
 * **It reclaims, and never queues.** A staged tar Mega does not hold is either
 * still uploading or was packed and queued moments ago, and sending it again
 * would duplicate a transfer that is already running. Adopting an unsent tar
 * belongs to recovery, which does it once at startup where the whole queue can
 * be read in one answer.
 */
const reclaimStaged = async (
  handle: DatabaseSync,
  config: ColdConfig,
  origin: Origin,
  parts:  PartRow[],
): Promise<number> => {
  let reclaimed = 0;

  const staging = path.join(config.coldRoot, origin);

  for (const local of stagedTars(staging)) {
    if (! fs.existsSync(local)) continue;

    const part = db.partByLocal(handle, origin, path.relative(staging, local));

    /**
     * Nothing describes it, so nothing can say what is inside — which is the one
     * case this must not act on. Recovery discards orphans at startup, where a
     * tar on disk can only have come from an earlier run; here it would be a
     * partly written one, and those are `.tar.tmp` until they are whole.
     */
    if (! part) continue;

    const found = await mega.remote(remotePath(config, part));

    if (! found || found.bytes !== fs.statSync(local).size) continue;

    if (! part.uploadedAt) db.markUploaded(handle, part.id, found.handle);

    fs.rmSync(local, { force: true });

    // A part this run owns is also held in memory, where its row is what drives
    // progress and the count printed at the end.
    const mine = parts.find(row => row.id === part.id);

    if (mine && ! mine.uploadedAt) mine.uploadedAt = new Date().toISOString();

    reclaimed++;
  }

  return reclaimed;
};

/** Wait out the queue once there is nothing left to pack. */
const drain = async (
  handle:   DatabaseSync,
  config:   ColdConfig,
  origin:   Origin,
  parts:    PartRow[],
  progress: Progress,
  remote:   Map<string, { bytes: number; handle: string | null }>,
): Promise<void> => {
  for (;;) {
    await settle(handle, config, origin, parts, remote);

    // Ends the run with the disk as clean as the record: a tar another venue's
    // run left behind is reclaimable the moment its upload lands, and waiting
    // for the next startup to notice leaves the buffer smaller than it looks.
    await reclaimStaged(handle, config, origin, parts);

    const left = parts.filter(part => ! part.uploadedAt);

    progress.settled(parts.length - left.length, 0);

    if (left.length === 0) return;

    progress.packingNow(null);

    await sleep(POLL_MS);
  }
};

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

export const _test_compare = compare;

export const _test_reclaimStaged = reclaimStaged;
export const _test_replanMonth   = replanMonth;
export const _test_sweepGhosts   = sweepGhosts;
