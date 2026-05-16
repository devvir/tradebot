import type { MongoClient, Db } from 'mongodb';
import SK from './service';
import { ensureSharedIndexes } from './utils/indexes';
import { distillQuotes } from './distillers/quote';
import { distillTrades } from './distillers/trade';
import { distillOrderBook } from './distillers/orderbook';
import { distillInstrument } from './distillers/instrument';
import { distillPartials } from './distillers/partials';
import type { Config } from './types';

SK.run(async (service) => {
  const config = service.config() as Config;
  const mongo  = await service.providers.connect('mongodb') as MongoClient;
  const db: Db = mongo.db(config.database);

  await service.providers.connect('redis');

  await ensureSharedIndexes(db);

  service.on('shutdown', async () => {
    service.setState('stopping', true);

    while ((service.state('distillers') as number) > 0) {
      await sleep(100);
    }
  });

  const d = config.distillers;

  await Promise.all([
    (! d || d.includes('quote'))      ? distillQuotes(db, service)     : null,
    (! d || d.includes('trade'))      ? distillTrades(db, service)     : null,
    (! d || d.includes('orderbook'))  ? distillOrderBook(db)           : null,
    (! d || d.includes('instrument')) ? distillInstrument(db)          : null,
    (! d || d.includes('partials'))   ? distillPartials(db)            : null,
  ].filter(Boolean));
});

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));
