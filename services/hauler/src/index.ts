import { logger } from '@devvir/service-kit';
import { haulVenue } from './venue';
import { constrain } from './constrain';
import { planFor } from './plan';
import { mount } from './api';
import { wants } from './wanted';
import SK from './service';
import config from './config';
import type { ExpressServerHandle, Service } from '@devvir/service-kit';
import type { Plan, Want } from './types';

/**
 * Hauler brings the catalog to disk, and does nothing else.
 *
 * **It does not discover.** Prospector knows what every venue publishes; hauler
 * asks for a list of URLs and fetches them. Whether those URLs follow an obvious
 * pattern or look random from here is not its business, and it never learns how
 * a venue structures its archive — no prefixes, no naming rules, no tree
 * walking.
 *
 * **It speaks one vocabulary and holds no translation.** Markets, datasets,
 * variants and instruments arrive from the catalog already canonical, because
 * turning a venue's own words into them is prospector's job and stops inside
 * prospector's adapters. Hauler asks in that vocabulary and files what comes
 * back under it.
 *
 * **It does not mirror the venue's hierarchy**, which is the largest break with
 * the collector it replaces. What a file *is* decides where it lands: venue,
 * market, dataset with its variants, month, symbol. A canonical archive is one a
 * reader can walk without knowing which venue served it.
 *
 * **Every venue runs on its own.** They are unrelated hosts with unrelated
 * limits, and sequencing them would make every venue wait behind the largest.
 */
const main = async (service: Service): Promise<void> => {
  /**
   * **Routes first, then bind.** The server is built by the plugin but not
   * started, because `start()` appends the one complete error handler — so
   * anything mounted after it would sit behind the handler meant to be last.
   */
  const api = service.servers.get() as ExpressServerHandle;

  mount(api.app, config.catalogToken);

  await api.start();

  logger.info({ port: config.port }, 'Shopping list API listening');

  /**
   * **`wants()` reads the standing intention; `constrain()` takes this
   * deployment's slice of it.** The two stay separate because `GET /wanted`
   * reads the same list and must go on showing the whole of it — narrowing it
   * here would make the shopping list say something different depending on
   * which deployment answered.
   */
  const list = constrain(wants(config.venues), config);

  /**
   * **An empty list is a state, not a failure.** The API is up, so the answer
   * to "why is nothing downloading" is one request away — and adding a want
   * needs no restart, since the next sweep reads the list again.
   */
  if (list.length === 0) {
    logger.warn({ venues: config.venues, markets: config.markets, datasets: config.datasets,
      from: config.from, to: config.to },
      'Nothing is wanted yet, or this deployment\'s env narrows it to nothing — add a want with PUT /wanted');

    return;
  }

  /**
   * **Resolved once, before any venue starts.** A want says what it needs; what
   * that means at this venue today is worked out against the catalog — see
   * `plan.ts` — so a want naming nothing anybody publishes is reported at the
   * top rather than discovered a month at a time.
   */
  const plans  = await resolve(list);
  const venues = [...new Set(plans.map(plan => plan.venue))].sort();

  if (plans.length === 0) {
    logger.warn({ wants: list.length },
      'Nothing wanted resolves to anything these venues publish '
      + '— check the names against GET /venues/:venue/shapes');

    return;
  }

  logger.info({ venues, wants: list.length, plans: plans.length,
    archives: config.archivesDir }, 'Hauling');

  /**
   * **One worker per venue, and nothing joins them.** A venue that finishes has
   * finished; a venue that is stuck on a partition the catalog and the disk
   * disagree about goes on asking about it every few minutes, which is the
   * correct behaviour and a visible one.
   */
  await Promise.allSettled(venues.map(venue => haulVenue(venue, plans, () => stopping)));

  logger.info({ venues }, 'Every venue has run out of work');
};

/**
 * Every want, turned into the listings it actually means.
 *
 * **One want can be several plans or none**, because it states a requirement
 * rather than an answer: asking for klines without naming an interval asks for
 * every interval the venue has, and asking for a book depth nobody publishes
 * asks for nothing at all. Both are reported rather than assumed — see
 * `plan.ts`.
 *
 * Resolved venue by venue rather than in parallel: it is a handful of requests
 * against rows the catalog holds in memory, and doing it before any fetching
 * starts is what puts a mistake in the first screen of the log.
 */
const resolve = async (list: readonly Want[]): Promise<Plan[]> => {
  const plans: Plan[] = [];

  for (const want of list) plans.push(...await planFor(want));

  return plans;
};

let stopping = false;

for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    stopping = true;

    logger.info('Stopping after the file in flight — nothing partial is ever left named');
  });

SK.run(main);
