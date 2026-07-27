import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from '@devvir/service-kit';
import SK from './service';
import { retryAbsences } from './absences';
import * as complete from './complete';
import * as coverage from './coverage';
import * as milestones from './milestones';
import { known } from './progress';
import { everyNonOverlapping } from './schedule';
import { sweepPartials } from './store';
import { syncVenue } from './sync';
import type { Config } from './types';

/**
 * Fail immediately and legibly if the mount is missing or not writable by this
 * container's user, rather than after a long listing pass. The host directory is
 * expected to exist and be owned by uid 1000 — see the service README.
 *
 * Declared **above** `SK.run`, which calls its callback while this module is
 * still evaluating: anything the callback reaches before its first `await` is
 * still in the temporal dead zone.
 */
const assertWritable = async (dir: string): Promise<void> => {
  const probe = join(dir, '.trucker-write-test');

  try {
    await mkdir(dir, { recursive: true });
    await writeFile(probe, '');
    await unlink(probe);
  } catch (err) {
    throw new Error(
      `Data directory '${dir}' is not writable (${(err as Error).message}). ` +
      `Create the host directory and give it to uid 1000: ` +
      `sudo mkdir -p <host-dir> && sudo chown 1000:1000 <host-dir>`,
    );
  }

  logger.info({ dir }, 'Data directory ready');
};

/**
 * Give every already-collected symbol a coverage entry, so an archive built
 * before that ledger existed is not read as never looked at.
 *
 * Runs on every start rather than once behind a flag: it is a pass over one
 * in-memory map per venue, it writes only what is missing, and a ledger that is
 * already complete costs nothing. There is no migration to remember to run and
 * no state saying whether it happened.
 */
const seedCoverage = async (venues: readonly string[]): Promise<void> => {
  for (const venue of venues) {
    const settled = await milestones.load(venue);
    const seeded  = await coverage.backfill(venue, settled);

    if (seeded > 0) logger.info({ venue, seeded }, 'Seeded coverage from existing milestones');
  }
};

/**
 * Publish a starting tip for whatever is already collected, so the first
 * month-major pass resumes at the oldest unfinished month instead of walking
 * years of history that is on disk.
 *
 * Derived from coverage rather than from the tree: what makes a month complete
 * is that every symbol was looked at past its end, which the files themselves
 * cannot say. A venue with any unwalked symbol seeds nothing and is simply
 * walked from the floor — correct, and the walk is cheap where the data is
 * already there.
 */
const seedTips = async (venues: readonly string[]): Promise<void> => {
  for (const venue of venues) {
    const through = await coverage.lowest(venue, await known(venue));

    if (! through) continue;

    const month = await complete.seed(venue, through);

    if (month) logger.info({ venue, month, through }, 'Seeded completion tip from coverage');
  }
};

SK.run(async (service) => {
  const config = service.config() as Config;

  await assertWritable(config.dataDir);

  const swept = await sweepPartials(config.dataDir);

  if (swept > 0) logger.info({ swept }, 'Removed interrupted downloads from a previous run');

  await seedCoverage(config.venues);
  await seedTips(config.venues);

  /**
   * Venues run **concurrently**. They are unrelated servers with independent
   * rate limits, so serialising them buys no politeness — the limiter is
   * per-venue — while costing a great deal: one venue's throttling, outage or
   * slow CDN would idle the whole service, and the last venue in the list would
   * wait for every earlier one to exhaust its entire catalogue.
   *
   * Total throughput is capped by the network either way; spreading it across
   * five venues means a stalled one leaves bandwidth for the rest, and every
   * venue gets some coverage early instead of one being mined to completion
   * first.
   */
  const sweep = async (): Promise<void> => {
    await Promise.all(config.venues.map(venue =>
      syncVenue(venue).catch(err =>
        logger.error({ err, venue }, 'Venue sync failed'))));
  };

  await sweep();

  await retryAbsences();

  // Archives are published on a daily cadence, so a periodic sweep is the whole
  // "keep up with new data" story: every pass re-lists, skips what is on disk,
  // and picks up whatever appeared. Same code path as the initial backfill.
  logger.info({ hours: config.rescanHours }, 'Backfill complete — rescanning periodically');

  everyNonOverlapping(
    config.rescanHours * 60 * 60 * 1000,
    async () => { await sweep().then(retryAbsences); },
  );
});
