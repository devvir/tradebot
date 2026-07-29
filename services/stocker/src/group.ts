import { idOf, keyOf } from './partition';
import { donatedMonths } from './spill';
import type { Candidate, Group, Grouper, RawFile } from './types';

/**
 * Assemble the walk's file stream into complete partitions.
 *
 * The walk is depth-first and sorted, so a partition's files are contiguous
 * and a partition is normally complete the moment a file with a different id
 * arrives. Spilling series bend that rule in two ways, and this machine exists
 * to absorb both without the sweep loop knowing:
 *
 * - A file in the first bucket of its month also carries the *previous*
 *   month's tail (`back`), so it is donated to that partition — and the
 *   partition must not close until every such donor has arrived, since a
 *   multi-part day splits the tail across several files.
 * - A file in the last bucket of its month carries the *next* month's head
 *   (`forward`); it is donated ahead, parked until that partition closes.
 *
 * Donations are filtered by the same `wanted` the sweep applies, so a file
 * whose own month is out of scope — the running month, past a bound — still
 * completes the neighbour that is in scope, and partitions nobody will build
 * collect no donations.
 */
export const grouper = (wanted: (file: Candidate) => boolean): Grouper => {
  const donations = new Map<string, RawFile[]>();

  /** Partitions of a `scattered` series, open until the walk leaves the symbol. */
  const gathered = new Map<string, Group>();

  /**
   * Every partition already handed over, so assembling one twice is caught here
   * rather than discovered later as a partition holding half its rows.
   *
   * **This is the invariant the streaming path rests on**, and nothing used to
   * check it: a series whose files are not contiguous produced the same id
   * twice, the second build silently replaced the first, and each sweep flagged
   * the other half as newly added and rebuilt for ever. It costs one string per
   * partition and turns that into an error at the moment it happens.
   */
  const emitted = new Set<string>();

  let current: Group  | null = null;
  let carry: RawFile[]       = [];
  let holding: string | null = null;

  /** Fold in donations and hand a partition over, once and only once. */
  const finish = (group: Group): Group => {
    const extra = donations.get(group.id);

    if (extra) {
      group.inputs.push(...extra);
      donations.delete(group.id);
    }

    /**
     * **A partition is assembled exactly once, and one that is not is refused.**
     *
     * Two things reach here. A series whose files are not contiguous and has not
     * said so — the second half silently replaced the first, and every sweep
     * afterwards rebuilt one from the other for ever. And a dataset a venue
     * publishes twice, monthly and daily, where both renderings were collected
     * for the same month: merging those would count every row twice.
     *
     * The rule needs to know about neither. A partition arriving a second time
     * means its inputs came from two places, which is a question about what was
     * collected rather than something to resolve by guessing — so it is marked
     * and the build is skipped, loudly, while the rest of the sweep continues.
     */
    if (emitted.has(group.id)) return { ...group, contested: true };

    emitted.add(group.id);

    return group;
  };

  /** Close the open partition, folding in whatever was donated to it. */
  const close = (): Group => {
    const group = current!;

    current = null;

    return finish(group);
  };

  /** The walk has left the symbol, so every partition gathered under it is whole. */
  const release = (): Group[] => {
    const done = [...gathered.values()].map(finish);

    gathered.clear();
    holding = null;

    return done;
  };

  const open = (inputs: RawFile[]): void => {
    const key = keyOf(inputs[0]!);

    current = { key, id: idOf(key), inputs };
  };

  const feed = (file: RawFile): Group[] => {
    const done: Group[] = [];

    // Record where this file's rows spill, for the partitions that want them.
    const targets = donatedMonths(file)
      .filter(month => wanted({ ...file, month }))
      .map(month => idOf({ ...keyOf(file), month }));

    for (const target of targets) {
      const list = donations.get(target) ?? [];

      list.push(file);
      donations.set(target, list);
    }

    if (! wanted(file)) return done;

    const key = keyOf(file);
    const id  = idOf(key);

    /**
     * A scattered series is gathered rather than streamed. Both markets share
     * one symbol directory on the venue that needs this, so the symbol — not the
     * partition — is what closes them, and every month under it closes together.
     */
    if (file.series.scattered) {
      if (holding !== null && holding !== key.symbol) done.push(...release());

      // Whatever the streaming path still holds belongs before these.
      if (current) done.unshift(close());

      holding = key.symbol;

      const group = gathered.get(id);

      if (group) group.inputs.push(file);
      else gathered.set(id, { key, id, inputs: [file] });

      return done;
    }

    // Past the scattered region, so nothing more can arrive for what it holds.
    if (holding !== null) done.push(...release());

    if (current && current.id !== id) {
      // A donor to the open partition must not close it: its siblings — the
      // other parts of the same bucket — may still be coming. Park it as the
      // seed of its own partition instead.
      if (targets.includes(current.id)) {
        carry.push(file);

        return done;
      }

      done.push(close());

      if (carry.length) {
        open(carry);

        carry = [];
      }

      if (current && (current as Group).id !== id) done.push(close());
    }

    if (current) current.inputs.push(file);
    else open([file]);

    return done;
  };

  /** The end of a source's walk: whatever is still open is complete. */
  const end = (): Group[] => {
    const done: Group[] = [];

    if (current) done.push(close());

    if (carry.length) {
      open(carry);

      carry = [];
      done.push(close());
    }

    if (holding !== null) done.push(...release());

    return done;
  };

  return { feed, end };
};
