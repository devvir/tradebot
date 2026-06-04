import type { RedisClient, FetchClientHandle } from '@devvir/service-kit';
import SK from './service';
import { createFetchService } from './bitmex';
import { logMetrics } from './bitmex/metrics';
import { createStoreService } from './vault';
import { TABLES } from './utils/tables';
import { processTable } from './runner';
import type { Config } from './types';

const METRICS_INTERVAL_MS = 60 * 1_000;

SK.run(async (service) => {
  const config = service.config() as Config;
  const cache  = await service.providers.connect('redis') as RedisClient;
  const fetch  = createFetchService(config.bitmexRestUrl);
  const store  = createStoreService(service.clients.get('vault') as FetchClientHandle);

  setInterval(logMetrics, METRICS_INTERVAL_MS).unref();

  await Promise.all(TABLES.map(table => processTable(table, fetch, store, cache)));
});
