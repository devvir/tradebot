import type { RedisClient } from '@devvir/service-kit';
import SK from './service';
import { createFetchService } from './bitmex';
import { createStoreService } from './vault';
import { fetchSymbols } from './utils/symbols';
import { loadRegistryMap } from './utils/registry';
import { runAllTables } from './runner';
import type { Config } from './types';

SK.run(async (service) => {
  const config = service.config() as Config;
  const cache  = await service.providers.connect('redis') as RedisClient;
  const fetch  = createFetchService(config.bitmexRestUrl);
  const store  = createStoreService(config.vaultUrl);

  /**
   * Discover recently added indexes before processing a new day
   * (used in the /instrument/compositeIndex per-index loop)
   */
  const getIndices = async (): Promise<string[]> => {
    const [map, { indices }] = await Promise.all([
      loadRegistryMap(config.registryUrl),
      fetchSymbols(config.bitmexRestUrl),
    ]);

    return [...indices].sort((a, b) => (map.get(a) ?? 0) - (map.get(b) ?? 0));
  };

  await runAllTables(fetch, store, cache, getIndices);
});
