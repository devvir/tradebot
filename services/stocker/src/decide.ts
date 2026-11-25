import { join } from 'node:path';
import { logger } from '@devvir/service-kit';
import { finishedPiece, pieceDirOf } from './build';
import config from './config';
import { filesOf, matches } from './disk';
import { edgesOf, idOf, neighbourOf } from './keys';
import { MISSING, outdate, partitionOf, readBackedUp, reinstate } from './ledger';
import { Prefetch } from './prepare';
import { NO_ROOM, roomIn, shortOf } from './room';
import { reachOf } from './spill';
import { bytesOf, groupsOf, piecedOf, sideGroupsOf, tasksOf, wrapOf } from './tasks';
import { countOf, freeGb, isWhole, labelOf, monthOf, revisionOf, stagingOf } from './vault';
import type { wrappedFor } from './build';
import type {
  DiskFile, Edge, Entry, Grain, InstrumentDirs, Job, Partition, Pass, Series, Side, Summary, Sweeping, Target, Task, VaultKey,
} from './types';

/**
 * Decide one vault partition: nothing to do, or what to stock it from — with
 * its archives' extraction started.
 *
 * Of the renderings on disk as the catalog says, the first by `PREFERENCE` is
 * the one stocked. What it finds is counted in `summary`; a vault volume below
 * its floor is `LowSpace`, thrown.
 */
export const decide = async (
  target:     Target,
  partitions: Map<string, Partition>,
  sweeping:   Sweeping,
  summary:    Summary,
): Promise<Job | null> => {
  const { key, series } = target;
  const spill = series[0]!.spill;

  const ready = target.candidates
    .filter(candidate => candidate.files > 0)
    .map(candidate => {
      const reach = reachFor(candidate, spill, partitions);

      return { candidate, ...reach, revision: revisionOf(key, candidate, series, reach.edges, reach.missing) };
    });

  /**
   * **The ledger answers, and without looking at the vault.** A partition it
   * holds at a revision one of these renderings computes is current — whether
   * or not its files are there, since a partition moved out of the vault is
   * still a partition stocked.
   */
  const partition = partitionOf(key);
  const entry     = sweeping.ledger.get(partition);
  const stocked   = entry ? ready.find(one => one.revision === entry.revision) : undefined;

  if (stocked) {
    summary.current++;

    if (stocked.missing.length > 0) summary.partial++;

    if (entry!.outdated) sweeping.ledger.set(partition, await reinstate(entry!));

    return null;
  }

  if (ready.length === 0) {
    summary.waiting++;

    return null;
  }

  /**
   * **Stocked, and not at a revision any rendering computes: it is outdated**,
   * and the ledger says so before anything is done about it — unless all that
   * is new is a neighbour's hours, which is a month still current and about to
   * be completed. Said first, so it is true however the stocking below ends:
   * its archives may not be on disk, and it then stays outdated until they are.
   */
  const stale = !! entry && ! ready.some(one => arrivedFor(entry, key, one, series).length > 0);

  if (entry && stale && ! entry.outdated) sweeping.ledger.set(partition, await outdate(entry));

  /** The sides a neighbour has arrived with that could not be built, and what of what they need is on disk. */
  let unbuilt: { sides: Side[]; main: boolean; sources: boolean } | null = null;

  /** Whether a rendering on disk was passed over for want of room to extract it. */
  let noRoom = false;

  /**
   * The preferred rendering that is on disk as the catalog says — the next one
   * if it is not, so a month whose monthly files are gone but whose dailies are
   * here still stocks.
   */
  for (const one of ready.sort((x, y) => rank(x.candidate) - rank(y.candidate))) {
    /**
     * **A month already stocked, whose neighbour has arrived, is not stocked
     * again.** Its own rows are in the vault and have not changed; what is new
     * is the hours the neighbour holds of it. So only those are built, from the
     * neighbour's files, and the month's own archives are not needed — they may
     * have left the disk long ago.
     *
     * **They are built beside every file the month has, or not at all.** A side
     * holds only the instruments the month's own files name, so with some of
     * those moved out of the vault the moved-out instruments' hours would never
     * be built. A month whose files in the vault are not every one its ledger
     * line counts waits until they are.
     */
    const arrived = entry ? arrivedFor(entry, key, one, series) : [];

    if (entry && arrived.length > 0) {
      const before = (await sweeping.slices.of(key)).get(monthOf(key));

      if (! isWhole(before) || countOf(before) !== entry.count) {
        unbuilt = { sides: arrived.map(edge => edge.end), main: false, sources: (await edgesOnDisk(arrived, sweeping.instruments)) !== null };

        continue;
      }

      const donated = await edgesOnDisk(arrived, sweeping.instruments);

      if (! donated) {
        unbuilt = { sides: arrived.map(edge => edge.end), main: true, sources: false };

        continue;
      }

      if (await freeGb() < config.minFreeGb) throw new LowSpace(await freeGb());

      const symbols = before!.bundle ? null : new Set(before!.symbols);
      const built   = await Promise.all(arrived.map(edge => piecedOf(tasksOf(sideGroupsOf(donated.get(edge.end) ?? [], symbols)))));
      const tasks   = built.flat();

      const passes = built.flatMap((own, at) => own.map((): Pass => arrived[at]!.end));
      const had = await builtOf(key, one.revision, tasks, passes);

      if (! await fits(key, tasks.filter((_, at) => ! had[at]))) {
        noRoom = true;

        continue;
      }

      return {
        key, partition: one.candidate, revision: one.revision, edges: one.edges, missing: one.missing, tasks, passes, built: had,
        files: [...donated.values()].flat().length, prefetch: new Prefetch(tasks, toBuild(tasks, had)),
        completes: { revision: entry.revision, sides: arrived.map(edge => edge.end), count: entry.count },
      };
    }

    const files = await filesOf(one.candidate.key, sweeping.instruments);

    if (! matches(files, one.candidate)) continue;

    const donated = await edgesOnDisk(one.edges, sweeping.instruments);

    if (! donated) continue;

    if (await freeGb() < config.minFreeGb) throw new LowSpace(await freeGb());

    const groups  = groupsOf(files);
    const symbols = new Set(groups.map(group => group.symbol));
    const own     = await piecedOf(tasksOf(groups));
    const sides   = await Promise.all(one.edges.map(edge => piecedOf(tasksOf(sideGroupsOf(donated.get(edge.end) ?? [], symbols)))));
    const tasks   = [...own, ...sides.flat()];

    const passes = [...own.map((): Pass => 'own'), ...sides.flatMap((side, at) => side.map((): Pass => one.edges[at]!.end))];
    const had = await builtOf(key, one.revision, tasks, passes);

    if (! await fits(key, tasks.filter((_, at) => ! had[at]))) {
      noRoom = true;

      continue;
    }

    return {
      key, partition: one.candidate, revision: one.revision, edges: one.edges, missing: one.missing, tasks, passes, built: had,
      files: files.length, prefetch: new Prefetch(tasks, toBuild(tasks, had)), completes: null,
    };
  }

  /**
   * **Stocked, and the hours a neighbour holds of it cannot be added yet.**
   * They are built from the neighbour's archives, beside the month's own files
   * — and one of the two is not on disk. Said for what it is: which is here,
   * which is not, and whether the month's own files have a copy elsewhere,
   * since that is the difference between bringing a file back and stocking the
   * month again. What is known of that copy is what the vault's own list says;
   * where the neighbour's archives are, only whether they are on disk.
   */
  if (entry && unbuilt) {
    summary.partial++;

    sweeping.backedUp ??= await readBackedUp();

    const safe  = sweeping.backedUp.get(partition)?.has(entry.revision) ?? false;
    const needs = [...(unbuilt.main ? [] : ['main parquet']), ...(unbuilt.sources ? [] : ['its sources'])].join(' and ');

    logger.warn({
      partition:      labelOf(key),
      'main parquet': `${safe ? 'backed up' : 'NOT backed up'}, ${unbuilt.main ? 'on disk' : 'not on disk'}`,
      ...Object.fromEntries(unbuilt.sides.map(side => [side, `pending, needs ${needs}`])),
      sources:        `${unbuilt.sides.join(' and ')} sources ${unbuilt.sources ? 'on disk' : 'missing on disk'}`,
    }, 'Spill pending');

    return null;
  }

  // On disk, and stocked when there is room: `fits` has said where there was none.
  if (noRoom) {
    summary.noRoom++;

    return null;
  }

  summary.missing++;

  if (stale) {
    summary.outdated++;

    logger.warn({ partition: labelOf(key), renderings: ready.map(one => one.candidate.id) },
      'Outdated, and its archives are not on disk as the catalog has them — it stays as it is until they are back');

    return null;
  }

  logger.info({ partition: labelOf(key), renderings: ready.map(one => one.candidate.id) },
    'Its archives are not on disk as the catalog has them — skipped');

  return null;
};

/** Why nothing more is decided or stocked: the vault's volume is below the configured floor. */
export class LowSpace extends Error {
  constructor(readonly free: number) {
    super(`vault volume has ${free.toFixed(1)} GB free`);
  }
}

// ── Internals ─────────────────────────────────────────────────────────────────

/**
 * Which rendering a vault partition is built from, when several are complete:
 * per-instrument files before a market bundle, then the coarsest grain — the
 * fewest files to read for the same rows.
 */
const PREFERENCE: Grain[] = ['monthly', 'daily', 'hourly', 'minutely'];

const rank = (partition: Partition): number =>
  (partition.key.bundle === 'instrument' ? 0 : 10) + PREFERENCE.indexOf(partition.key.grain);

/**
 * The sides a stocked month was missing that are there to be read now — where
 * that is the only thing that has changed.
 *
 * The ledger line has to be of this very rendering at this very version, and
 * the revision it names has to be the one this rendering would have computed
 * with those sides missing. Anything else — a file of the month changed, a
 * series edited, a neighbour replaced — is a month to stock again from its own
 * archives, and answers with nothing here.
 */
const arrivedFor = (
  entry:  Entry,
  key:    VaultKey,
  one:    { candidate: Partition; edges: Edge[]; missing: Side[] },
  series: Series[],
): Edge[] => {
  const source = one.candidate.key;

  if (entry.grain !== source.grain || entry.bundle !== source.bundle || entry.version !== one.candidate.version) return [];

  const was: Side[] = [];

  if (entry.preVersion === MISSING)  was.push('pre');
  if (entry.postVersion === MISSING) was.push('post');

  const arrived = one.edges.filter(edge => was.includes(edge.end));

  if (arrived.length === 0) return [];

  const then = revisionOf(key, one.candidate, series, one.edges.filter(edge => ! was.includes(edge.end)), was);

  return then === entry.revision ? arrived : [];
};

/**
 * The neighbours' edge files, side by side — or null unless every neighbour is
 * on disk as the catalog says. The neighbour is checked whole, since that is
 * what the catalog counts; only its edge is read.
 */
const edgesOnDisk = async (edges: readonly Edge[], instruments: InstrumentDirs): Promise<Map<Side, DiskFile[]> | null> => {
  const donated = new Map<Side, DiskFile[]>();

  for (const edge of edges) {
    const all = await filesOf(edge.partition.key, instruments);

    if (! matches(all, edge.partition)) return null;

    donated.set(edge.end, all.filter(found => edgesOf(found.file)[edge.side]));
  }

  return donated;
};

/**
 * The neighbouring months a candidate reads the edge of: those that are in the
 * catalog's answer, and the sides whose neighbour is not. A partition that does
 * not spill has neither.
 */
const reachFor = (
  candidate:  Partition,
  spill:      Series['spill'],
  partitions: Map<string, Partition>,
): { edges: Edge[]; missing: Side[] } => {
  const edges: Edge[]   = [];
  const missing: Side[] = [];

  for (const { by, side } of reachOf(spill)) {
    const neighbour = partitions.get(idOf(neighbourOf(candidate.key, by)));
    const end: Side = by > 0 ? 'post' : 'pre';

    if (! neighbour || neighbour.files === 0) missing.push(end);
    else edges.push({ partition: neighbour, side, end });
  }

  return { edges, missing };
};

/** For each task, what came of it where it is a piece a build before this one finished — see `finishPiece`. */
const builtOf = (key: VaultKey, revision: string, tasks: Task[], passes: Pass[]): Promise<Job['built']> =>
  Promise.all(tasks.map((task, at) => {
    const group = task[0]!;

    return group.piece ? finishedPiece(pieceDirOf(join(stagingOf(key, revision), passes[at]!), group.piece), group.inputs) : null;
  }));

/** A task's archives as extraction is asked for them — none, where it is a piece that is built already. */
const toBuild = (tasks: Task[], built: Job['built']): ((task: Task) => ReturnType<typeof wrappedFor>) =>
  task => (built[tasks.indexOf(task)] ? { inputs: [], shapes: [], series: [] } : wrapOf(task));

/**
 * Whether there is room to extract each of a partition's tasks, said where
 * there is not. Asked before the partition is started; each extraction asks
 * again as it starts, of the space there is then.
 */
const fits = async (key: VaultKey, tasks: Task[]): Promise<boolean> => {
  for (const task of tasks) {
    const short = await shortOf(wrapOf(task).inputs, task.reduce((total, group) => total + bytesOf(group), 0));

    if (! short) continue;

    logger.warn({ partition: labelOf(key), ...roomIn(short) }, NO_ROOM);

    return false;
  }

  return true;
};
