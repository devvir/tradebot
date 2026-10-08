import { logger } from '@devvir/service-kit';
import type { Service } from '@devvir/service-kit';
import { venues } from './catalog';
import { sweepPartials } from './store';
import { dropHeld } from './held';
import { setHosts } from './hosts';
import { abandon } from './fetch';
import { walkVenue } from './venue';
import SK from './service';
import config from './config';

/**
 * Brings catalogued venue files to disk, under canonical names.
 *
 * Prospector establishes what every venue publishes; hauler walks each venue as
 * a bucket the catalog serves — only what is still owed, through a lens where
 * one is configured — fetches what it lists, and reports. It never discovers,
 * never learns how a venue structures its archive, and never names a file:
 * each key is where its file goes.
 *
 * **Every venue walks on its own loop**, and how soon it walks again depends on
 * the last walk: soon after one that found work, since a backfill in progress
 * keeps cataloguing more; later after one that found nothing, since new files
 * may be landing outside the lens and asking often would only list nothing.
 */
const main = async (service: Service): Promise<void> => {
  service.on('shutdown', stopAfterFlight);

  const swept = await sweepPartials();

  logger.info({ swept }, swept > 0 ? 'Removed unfinished downloads' : 'No unfinished downloads');

  logger.info('Asking the catalog which venues there are, and where they answer');

  // Asked whichever venues are configured: where each one's servers answer is the catalog's to say.
  const found = await untilAnswered(venues);
  const names = config.venues.length > 0 ? config.venues : found.map(one => one.venue);

  for (const one of found) setHosts(one.venue, one.hosts);

  logger.info({ venues: names, lens: config.lens || '(none — every file)', archives: config.archivesDir },
    'Hauling');

  hauling = Promise.allSettled(names.map(loop));

  await hauling;

  logger.info('Every venue has stopped');
};

/** Walk a venue, wait, and walk it again, until the service stops. */
const loop = async (venue: string): Promise<void> => {
  while (! stopping) {
    let found = false;

    try {
      const walked = await walkVenue(venue, () => stopping);

      found = walked.progressed > 0 && ! walked.full;

      if (walked.full)
        logger.warn({ venue, ...walked, minFreeGb: config.minFreeGb, nextInMinutes: QUIET_MS / 60_000 },
          'The archives volume is low on space — nothing more is fetched until there is room');
      else
        logger.info({ venue, ...walked, nextInMinutes: (found ? FOUND_MS : QUIET_MS) / 60_000 }, 'Walk finished');

      // Nothing owed is nothing left to settle: what was held for the catalog to rule on was not what it ruled for.
      if (walked.listed === 0) await dropHeld(venue);
    } catch (err) {
      logger.error({ err, venue }, 'Walk failed — trying again later');
    }

    await rest(found ? FOUND_MS : QUIET_MS);
  }
};

/** After a walk that brought files to disk: the catalog is likely still adding more. */
const FOUND_MS = 5 * 60_000;

/** After a walk that found nothing to do. */
const QUIET_MS = 30 * 60_000;

/** Ask until the catalog answers, a minute apart — hauler has nothing to do without it. */
const untilAnswered = async <T>(ask: () => Promise<T>): Promise<T> => {
  for (;;) {
    try {
      return await ask();
    } catch (err) {
      logger.warn({ err }, 'The catalog is not answering yet — asking again in a minute');

      await rest(60_000);
    }
  }
};

/** Wait, waking at once when the service is asked to stop. */
const rest = async (ms: number): Promise<void> => {
  const until = Date.now() + ms;

  while (! stopping && Date.now() < until) await new Promise(done => setTimeout(done, Math.min(1_000, until - Date.now())));
};

let stopping = false;

/** Every venue's loop, once started — what a shutdown waits on. */
let hauling: Promise<unknown> = Promise.resolve();

/**
 * **A shutdown gives the files in flight `FLIGHT_MS`, and no longer.** No new
 * file is taken, and the ones already downloading are given that long to
 * finish. Whatever is still downloading then is given up — left owed, its
 * partial removed — so that every page is reported before the process exits:
 * a stop is an order, and what was done before it is not to be done twice
 * for the sake of a few files that were slow.
 *
 * `FLIGHT_MS` is half the compose file's `stop_grace_period`, which leaves the
 * other half for the reports to go out before the container is killed.
 */
const stopAfterFlight = async (): Promise<void> => {
  stopping = true;

  logger.info({ seconds: FLIGHT_MS / 1000 }, 'Stopping — the files in flight are given a moment to finish');

  let waited: NodeJS.Timeout | undefined;

  const landed = await Promise.race([
    hauling.then(() => true),
    new Promise<boolean>((resolve) => { waited = setTimeout(() => resolve(false), FLIGHT_MS); }),
  ]);

  clearTimeout(waited);

  if (! landed) {
    logger.info('Giving up the files still in flight — they stay owed');

    abandon();

    await hauling;
  }
};

/** How long a stop waits for the files in flight before giving them up. */
const FLIGHT_MS = 15_000;


SK.run(main);
