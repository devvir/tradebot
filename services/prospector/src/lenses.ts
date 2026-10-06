import { logger } from '@devvir/service-kit';
import { catchUp, lenses } from '@tradebot/lenses';
import { slice } from './catalog/serial';
import { fault } from './faults';
import type { DatabaseSync } from 'node:sqlite';

/**
 * Working out what every lens lets through, and keeping it so as partitions
 * appear.
 *
 * **Done here because it is a write.** A lens's members are rows of the catalog
 * database, and this service is the only thing that writes it — so the rows are
 * settled in the same queue as every other write (`slice`), a step at a time,
 * and never wait on a lock or make anything else wait on one.
 *
 * **One walk does both jobs.** A lens reads the partitions past the newest it
 * has looked at. As the catalog grows that is the few that have just appeared;
 * after its rules are saved it is all of them, from the first — the save having
 * answered already, and this being what it left to be done.
 *
 * **A round runs every `EVERY_MS`, and at once when a lens is saved**
 * (`lensesChanged`). So a lens is at most that far behind partitions that have
 * only just been found, and a saved lens starts being worked out as soon as its
 * save has answered.
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

        for (const lens of lenses(db))
          while (await slice(() => catchUp(db, lens, STEP)));
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

    round = async () => {};
  };
};

/** A lens was made or given new rules: start working it out now, without waiting for the next round. */
export const lensesChanged = (): void => void round();

// ── Internals ─────────────────────────────────────────────────────────────────

/** How often the lenses are brought up to date. A round with nothing new is one read per lens. */
const EVERY_MS = 30_000;

/** Partitions looked at per step: one turn in the write queue, between which every other write takes its own. */
const STEP = 500;

/** A round of bringing the lenses up to date; nothing until `keepLensesCurrent` has been started. */
let round: () => Promise<void> = async () => {};
