import { logger } from '@devvir/service-kit';
import type { Service } from '@devvir/service-kit';
import { halt, venues } from './catalog';
import { sweepPartials } from './store';
import { dropHeld } from './held';
import { setHosts } from './hosts';
import { abandon } from './fetch';
import { makeRunner } from './run';
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
 * Each venue walks on its own loop, soon again after a walk that found work and
 * later after one that found nothing; see `run.ts`.
 */
const main = async (service: Service): Promise<void> => {
  service.on('shutdown', runner.stopAfterFlight);

  const swept = await sweepPartials();

  logger.info({ swept }, swept > 0 ? 'Removed unfinished downloads' : 'No unfinished downloads');

  logger.info('Asking the catalog which venues there are, and where they answer');

  // Asked whichever venues are configured: where each one's servers answer is the catalog's to say.
  const found = await runner.untilAnswered(venues);
  const names = config.venues.length > 0 ? config.venues : found.map(one => one.venue);

  for (const one of found) setHosts(one.venue, one.hosts);

  logger.info({ venues: names, lens: config.lens || '(none — every file)', archives: config.archivesDir },
    'Hauling');

  await runner.start(names);

  logger.info('Every venue has stopped');
};

/**
 * After a walk that brought files to disk: a backfill in progress keeps
 * cataloguing more, so the venue is likely to owe more soon.
 */
const FOUND_MS = 5 * 60_000;

/**
 * After a walk that found nothing to do: new files may be landing outside the
 * lens, and asking often would only list nothing.
 */
const QUIET_MS = 30 * 60_000;

/**
 * How long a stop waits for the files in flight before giving them up: half the
 * compose file's `stop_grace_period`, which leaves the other half for the
 * reports to go out before the container is killed.
 */
const FLIGHT_MS = 15_000;

/**
 * Between asks for the venues. Hauler has nothing to do without them. A catalog
 * that is away is waited for by the request itself; what reaches here is a
 * refusal, which a fixed token or lens puts right.
 */
const RETRY_MS = 60_000;

const runner = makeRunner({
  walkVenue, dropHeld, halt, abandon,
  minFreeGb: config.minFreeGb,
  foundMs:   FOUND_MS,
  quietMs:   QUIET_MS,
  flightMs:  FLIGHT_MS,
  retryMs:   RETRY_MS,
});

SK.run(main);
