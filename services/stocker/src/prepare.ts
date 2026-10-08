import { EXPANSION, needsExtracting, pool, unpackAll } from './containers';
import { NoRoom, shortOf } from './room';
import { freeGb } from './vault';
import type { Pack, UnpackedAll, Wrapped } from './containers';
import type { PrepareSlot, Task } from './types';

/**
 * Extraction that runs ahead of the builds.
 *
 * **A build waits on its archives being extracted, and nothing else has to.**
 * A month of small files is tens of thousands of archives and a few megabytes
 * of rows: nearly all of what it costs is extracting them, during which the
 * engine has nothing to do. So extraction is started before a build asks for
 * it — for the tasks of the partition being built that are still to come, and
 * then for those of the partition after it — on the threads of the pool, while
 * the engine works on whatever is already extracted.
 *
 * Nothing here knows a venue or a format. Whether a task needs extracting at
 * all is read off its own files, so a partition of files the engine reads
 * natively passes straight through and costs nothing.
 *
 * **What is extracted ahead is bounded by the disk it sits on**: no more than
 * `SCRATCH_SHARE` of the vault volume's free space, counted in what the
 * extractions actually wrote. Past that nothing more is started until a build
 * has read and removed something. A task a build is waiting on is never held
 * back by it — the bound is on getting ahead, not on working.
 *
 * **Nothing is extracted without room for it** — see `room.ts` — ahead or
 * asked for. Ahead, a task there is no room for is left for its build to ask
 * for; asked for, it fails with `NoRoom`.
 */
export class Prefetch {
  /**
   * `wrap` says how a task's archives are asked for — which of them may have
   * their small files gathered, and under what shape. Left out, every archive
   * is extracted as it is.
   */
  constructor(tasks: readonly Task[], wrap: (task: Task) => { inputs: Wrapped[]; shapes: Pack[] } = asTheyAre) {
    this.slots = tasks.map(task => {
      const { inputs, shapes } = wrap(task);

      const extracts = needsExtracting(inputs);
      const weight   = task.reduce((sum, group) => sum + group.inputs.reduce((all, one) => all + one.size, 0), 0);

      return { inputs, shapes, extracts, weight, estimate: extracts ? weight * EXPANSION : 0, waits: false, charged: 0, flying: false, promise: null, taken: false };
    });

    waiting.push(this);

    pump();
  }

  private readonly slots: PrepareSlot[];

  /**
   * A task's archives, extracted — at once where that was done ahead, and
   * started now where it was not. What is returned is the build's to remove.
   */
  async take(at: number): Promise<UnpackedAll> {
    const slot = this.slots[at]!;

    slot.taken = true;

    const unpacked = await (slot.promise ?? start(slot));

    return {
      ...unpacked,
      dispose: async (): Promise<void> => {
        await unpacked.dispose();

        uncharge(slot);
        pump();
      },
    };
  }

  /** Stop getting ahead for these tasks, and remove whatever was extracted for a build that never came. */
  release(): void {
    const at = waiting.indexOf(this);

    if (at >= 0) waiting.splice(at, 1);

    for (const slot of this.slots) {
      if (slot.taken || ! slot.promise) continue;

      slot.taken = true;

      void slot.promise.then(
        async (unpacked) => { await unpacked.dispose(); uncharge(slot); pump(); },
        () => { uncharge(slot); pump(); },
      );
    }

    pump();
  }

  /** The next task nothing has started on, or null. */
  upcoming(): PrepareSlot | null {
    return this.slots.find(slot => ! slot.promise && ! slot.taken && ! slot.waits) ?? null;
  }
}

/** What is extracted and not yet removed, with what is being extracted counted at its estimate. */
export const _test_held = (): number => held;

// ── Internals ─────────────────────────────────────────────────────────────────

/** A task's archives, each to be extracted as it is. */
const asTheyAre = (task: Task): { inputs: Wrapped[]; shapes: Pack[] } => ({
  inputs: task.flatMap(group => group.inputs.map(input => ({ absolute: input.absolute, container: input.file.container }))),
  shapes: [],
});

/** Every prefetch that may still want something started, the one being built first. */
const waiting: Prefetch[] = [];

/** Extractions running that were started to get ahead. */
let flying = 0;

/** Bytes of scratch spoken for. */
let held = 0;

/** The most that may be spoken for, and when the disk was last asked. */
let limit     = 0;
let measured  = 0;
let measuring = false;

/**
 * Start what there is room for: threads first, then disk. The partition being
 * built is asked before the one after it, so getting ahead of the next never
 * delays the one in hand.
 */
const pump = (): void => {
  if (Date.now() - measured > MEASURE_MS && ! measuring) {
    measuring = true;

    void freeGb().then(
      (free) => { limit = Math.min(free * 1024 ** 3 * SCRATCH_SHARE, SCRATCH_BYTES); },
      () => {},
    ).then(() => {
      measured  = Date.now();
      measuring = false;

      pump();
    });
  }

  while (flying < pool.size) {
    const slot = waiting.map(one => one.upcoming()).find(one => one !== null);

    if (! slot) return;

    // Something is always let through where nothing is held: one task larger than the bound must still be built.
    if (slot.extracts && held > 0 && held + slot.estimate > limit) return;

    void start(slot).catch(() => {});
  }
};

/** Extract a task's archives, charged at its estimate until what it wrote is known. */
const start = (slot: PrepareSlot): Promise<UnpackedAll> => {
  slot.charged = slot.estimate;
  slot.flying  = slot.extracts;

  held += slot.charged;

  if (slot.flying) flying++;

  const landed = (): void => {
    if (! slot.flying) return;

    slot.flying = false;
    flying--;
  };

  const extracting = shortOf(slot.inputs, slot.weight).then((short) => {
    if (short) throw new NoRoom(short);

    return unpackAll(slot.inputs, slot.shapes);
  });

  const promise: Promise<UnpackedAll> = extracting.then(
    (unpacked) => {
      landed();

      held += unpacked.bytes - slot.charged;
      slot.charged = unpacked.bytes;

      pump();

      return unpacked;
    },
    (err) => {
      landed();
      uncharge(slot);

      // No room for it ahead of its build: asked again when the build gets to it.
      if (err instanceof NoRoom && ! slot.taken && slot.promise === promise) {
        slot.promise = null;
        slot.waits   = true;
      }

      pump();

      throw err;
    },
  );

  slot.promise = promise;

  return promise;
};

const uncharge = (slot: PrepareSlot): void => {
  held -= slot.charged;
  slot.charged = 0;
};

/** The share of the vault volume's free space that may be filled with archives extracted ahead. */
const SCRATCH_SHARE = 0.2;

const SCRATCH_BYTES = 2 * 1024 ** 3;

/** How long a reading of the disk's free space is used for. */
const MEASURE_MS = 5_000;
