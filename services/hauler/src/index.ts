import { logger } from '@devvir/service-kit';
import type { Service } from '@devvir/service-kit';
import { venues } from './catalog';
import { sweepPartials } from './store';
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

  const swept = await sweepPartials(config.archivesDir);

  if (swept > 0) logger.info({ swept, archives: config.archivesDir }, 'Removed unfinished downloads');

  const names = config.venues.length > 0 ? config.venues : await untilAnswered(venues);

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

      found = walked.progressed > 0;

      logger.info({ venue, ...walked, nextInMinutes: (found ? FOUND_MS : QUIET_MS) / 60_000 }, 'Walk finished');
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
 * **A shutdown waits for the files in flight.** No new file is taken, the ones
 * already downloading finish and are reported, and only then does the process
 * exit — so a stop leaves no `.part` behind and nothing done goes unreported.
 * How long that may take is the compose file's `stop_grace_period`.
 */
const stopAfterFlight = async (): Promise<void> => {
  stopping = true;

  logger.info('Stopping after the files in flight');

  await hauling;
};


SK.run(main);
