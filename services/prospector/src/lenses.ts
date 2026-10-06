import { logger } from '@devvir/service-kit';
import { catchUp, lensNamed, lenses } from '@tradebot/lenses';
import { fault } from './faults';
import type { DatabaseSync } from 'node:sqlite';

/**
 * Working out what every lens lets through, and keeping it so as partitions
 * appear.
 *
 * **Done here because it is a write.** A lens's members are rows of the catalog
 * database, and this service is the only thing that writes it, so nothing here
 * waits on a lock or makes anything else wait on one.
 *
 * **A lens does what is past the newest partition it has looked at.** As the
 * catalog grows that is the few that have just appeared; after its rules are
 * saved it is all of them, worked out in one pass — the save having answered
 * already, and this being what it left to be done.
 *
 * **Not in the queue the survey's writes wait in.** That queue can be seconds
 * deep while a venue is walked, and a lens somebody has just saved is waited
 * for by a person. Every write in this service is synchronous from its `BEGIN`
 * to its `COMMIT`, so a step run between two turns of the loop finds nothing
 * half way through one; the loop is handed back after each.
 *
 * **A round runs every `EVERY_MS`, and a moment after a lens is saved**
 * (`lensesChanged`). So a lens is at most that far behind partitions that have
 * only just been found, and a saved lens is worked out as soon as whoever is
 * saving it has stopped.
 */
export const keepLensesCurrent = (db: DatabaseSync): (() => void) => {
  let running = false;
  let again   = false;

  round = async (): Promise<void> => {
    // Asked for while one is under way: a lens saved since it read the list is taken up by the next.
    if (running) {
      again = true;

      return;
    }

    running = true;

    try {
      do {
        again = false;

        for (const { slug } of lenses(db))
          for (;;) {
            // Read again each step: its rules may have been saved since the last one.
            const lens = lensNamed(db, slug);

            if (! lens || ! catchUp(db, lens, STEP)) break;

            await new Promise(done => setImmediate(done));
          }
      } while (again);
    } catch (err) {
      logger.warn({ ...fault(err) }, 'Could not bring the lenses up to date — trying again shortly');
    } finally {
      running = false;
    }
  };

  void round();

  const timer = setInterval(() => void round(), EVERY_MS);

  timer.unref();

  return () => {
    clearInterval(timer);
    clearTimeout(soon);

    round = async () => {};
  };
};

/**
 * A lens was made or given new rules: have it worked out shortly, without
 * waiting for the next round.
 *
 * **Shortly, and once for a run of saves.** Rules are stored one at a time, so
 * somebody changing several stores the lens several times in a few seconds —
 * and only what the last of them left is worth working out. Each save puts the
 * start off by `SETTLE_MS`, longer than a person takes between two rules, so a run of them is one pass, over the rules as they
 * stand when it begins. A save that arrives after a pass has begun is simply
 * the next pass: a pass is never left half done, and never done over rules that
 * have since been replaced.
 *
 * Never in the turn that asked: the save is answered first.
 */
export const lensesChanged = (): void => {
  clearTimeout(soon);

  soon = setTimeout(() => void round(), settleMs);
  soon.unref();
};

// ── Internals ─────────────────────────────────────────────────────────────────

/** How often the lenses are brought up to date. A round with nothing new is one read per lens. */
const EVERY_MS = 30_000;

/** Partitions settled per step, between which the loop is handed back: a query for each, so few. */
const STEP = 50;

/** How long after the last save of a run the lenses are worked out. */
const SETTLE_MS = 5_000;

let settleMs = SETTLE_MS;

/** The start of a round that a save asked for, while it can still be put off by another. */
let soon: ReturnType<typeof setTimeout> | undefined;

/** A round of bringing the lenses up to date; nothing until `keepLensesCurrent` has been started. */
let round: () => Promise<void> = async () => {};

// ── Test access ───────────────────────────────────────────────────────────────

/** Work the lenses out this long after a save, or as long as the service waits again. */
export const _test_settleMs = (ms: number | null): void => { settleMs = ms ?? SETTLE_MS; };
