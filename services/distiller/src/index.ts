import type { MongoClient } from 'mongodb';
import { type Service, logger } from '@devvir/service-kit';
import SK from './service';
import { ensureSharedIndexes } from './indexes';
import { distillQuotes } from './generators/quote';
import { distillTrades } from './generators/trade';
import { distillOrderBook } from './generators/orderbook';
import { distillInstrument } from './generators/instrument';
import { distillPartials } from './generators/partials';
import type { Config } from './types';

const SLEEP_MS = 3_600_000;

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

SK.run(async (service: Service) => {
  const config = service.config() as Config;
  const mongo = await service.providers.connect('mongodb') as MongoClient;

  await ensureSharedIndexes();

  const g = config.generators;

  while (true) {
    await Promise.all([
      (! g || g.includes('quote'))      ? distillQuotes(mongo, config.database)      : null,
      (! g || g.includes('trade'))      ? distillTrades(mongo, config.database)      : null,
      (! g || g.includes('orderbook'))  ? distillOrderBook(mongo, config.database)   : null,
      (! g || g.includes('instrument')) ? distillInstrument(mongo, config.database)  : null,
      (! g || g.includes('partials'))   ? distillPartials(mongo, config.database)    : null,
    ]);

    logger.info('All aggregations complete — taking a nap...');

    await sleep(SLEEP_MS);
  }
});
