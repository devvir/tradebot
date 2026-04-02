import type { MongoClient } from 'mongodb';
import { type Service, logger } from '@devvir/service-kit';
import SK from './service';
import { bootstrap } from './bootstrap';
import { distillQuotes } from './generators/quote';
import { distillTrades } from './generators/trade';
import { distillOrderBook }    from './generators/orderbook';
import { distillInstrument }  from './generators/instrument';
import { distillPartials }    from './generators/partials';
import type { Config } from './types';

const SLEEP_MS = 3_600_000;

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

SK.run(async (service: Service) => {
  const config = service.config() as Config;
  const mongo  = await service.providers.connect('mongodb') as MongoClient;

  await bootstrap(mongo, config.database);

  while (true) {
    await Promise.all([
      distillQuotes(mongo, config.database),
      distillTrades(mongo, config.database),
      distillOrderBook(mongo, config.database),
      distillInstrument(mongo, config.database),
      distillPartials(mongo, config.database),
    ]);

    logger.info('All aggregations complete — taking a nap...');

    await sleep(SLEEP_MS);
  }
});
