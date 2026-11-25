import { logger } from '@devvir/service-kit';
import type { Walked } from './types';

/** What a runner walks with, and how long it waits between walks. */
export interface RunnerOf {
  /** One walk of a venue, end to end, taking no new file once `stopped` says so. */
  walkVenue: (venue: string, stopped: () => boolean) => Promise<Walked>;

  /** Count the start of a walk of a venue, for what it holds. */
  startWalk: (venue: string) => void;

  /** Drop whatever is held of a venue, answering how many there were. */
  dropHeld:  (venue: string) => Promise<number>;

  /** Drop what is held of a venue from walks long enough ago and not listed since, answering how many. */
  dropStale: (venue: string) => Promise<number>;

  /** Stop waiting for the catalog. */
  halt:      () => void;

  /** Give up every download in flight. */
  abandon:   () => void;

  /** The archives' volume floor, said in the log when a walk ends for want of space. */
  minFreeGb: number;

  /** The wait after a walk that brought files to disk. */
  foundMs:   number;

  /** The wait after any other walk, or one that failed. */
  quietMs:   number;

  /** How long a stop gives the files in flight. */
  flightMs:  number;

  /** The wait before asking `untilAnswered` again. */
  retryMs:   number;
}

/** Every venue's loop, and how it is stopped. */
export interface Runner {
  /** Walk every venue named, each on its own loop, until the runner is stopped. */
  start:           (names: string[]) => Promise<void>;

  /** Ask until there is an answer, `retryMs` apart. */
  untilAnswered:   <T>(ask: () => Promise<T>) => Promise<T>;

  /** Stop every loop, giving the files in flight `flightMs`. */
  stopAfterFlight: () => Promise<void>;
}

/**
 * Walk each venue, wait, and walk it again, until stopped.
 *
 * **Every venue walks on its own loop**, and how soon it walks again depends on
 * the last walk: `foundMs` after one that brought files to disk, `quietMs` after
 * one that did not, that ran out of space, or that failed. A failed walk is
 * logged and tried again; nothing a walk does ends its loop.
 *
 * **What is held for the catalog to rule on is let go of when it is no longer
 * owed.** Everything held of a venue is dropped after a walk whose venue owed
 * nothing; what was held walks ago and not listed since is dropped after a walk
 * that went through everything owed — not one cut short by a stop, a full
 * volume or a listing that ended early, which says nothing of what it did not reach.
 *
 * **A stop gives the files in flight `flightMs`, and no longer.** No new file is
 * taken, the catalog is no longer waited for, and the downloads already running
 * are given that long to finish. Whatever is still downloading then is given
 * up — left owed, its partial removed — so that every page is reported before
 * the process exits: a stop is an order, and what was done before it is not to
 * be done twice for the sake of a few files that were slow.
 *
 * Each runner keeps its own state, so one stopped is stopped alone.
 */
export const makeRunner = (deps: RunnerOf): Runner => {
  let stopping = false;

  /** Every venue's loop, once started — what a stop waits on. */
  let hauling: Promise<unknown> = Promise.resolve();

  /** Wait, waking within a second when the runner is stopped. */
  const rest = async (ms: number): Promise<void> => {
    const until = Date.now() + ms;

    while (! stopping && Date.now() < until)
      await new Promise(done => setTimeout(done, Math.min(1_000, until - Date.now())));
  };

  const loop = async (venue: string): Promise<void> => {
    while (! stopping) {
      let found = false;

      try {
        deps.startWalk(venue);

        const walked = await deps.walkVenue(venue, () => stopping);

        found = walked.progressed > 0 && ! walked.full;

        if (walked.full)
          logger.warn({ venue, ...walked, minFreeGb: deps.minFreeGb, nextInMinutes: deps.quietMs / 60_000 },
            'The archives volume is low on space — nothing more is fetched until there is room');
        else
          logger.info({ venue, ...walked, nextInMinutes: (found ? deps.foundMs : deps.quietMs) / 60_000 },
            'Round finished');

        const dropped = walked.nothingOwed ? await deps.dropHeld(venue)
          : ! walked.full && ! walked.cut && ! stopping ? await deps.dropStale(venue)
          : 0;

        if (dropped > 0)
          logger.info({ venue, dropped }, walked.nothingOwed
            ? 'Nothing is owed — dropped every download held for the catalog to rule on'
            : 'Dropped downloads held for files no longer listed');
      } catch (err) {
        logger.error({ err, venue }, 'Walk failed — trying again later');
      }

      await rest(found ? deps.foundMs : deps.quietMs);
    }
  };

  const start = async (names: string[]): Promise<void> => {
    hauling = Promise.allSettled(names.map(loop));

    await hauling;
  };

  const untilAnswered = async <T>(ask: () => Promise<T>): Promise<T> => {
    for (;;) {
      try {
        return await ask();
      } catch (err) {
        logger.warn({ err: (err as Error).message, retryInSeconds: deps.retryMs / 1000 },
          'The catalog refused the list of venues — asking again');

        await rest(deps.retryMs);
      }
    }
  };

  const stopAfterFlight = async (): Promise<void> => {
    stopping = true;
    deps.halt();

    logger.info({ seconds: deps.flightMs / 1000 }, 'Stopping — the files in flight are given a moment to finish');

    let waited: NodeJS.Timeout | undefined;

    const landed = await Promise.race([
      hauling.then(() => true),
      new Promise<boolean>((resolve) => { waited = setTimeout(() => resolve(false), deps.flightMs); }),
    ]);

    clearTimeout(waited);

    if (! landed) {
      logger.info('Giving up the files still in flight — they stay owed');

      deps.abandon();

      await hauling;
    }
  };

  return { start, untilAnswered, stopAfterFlight };
};
