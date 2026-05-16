import type { RedisClient } from '@devvir/service-kit';
import SK from './service';
import { syncTable, scheduleNextPoll } from './loop';
import type { Config } from './types';

SK.run(async (service) => {
  const { vaultUrl, tables } = service.config() as Config;
  const redis                = await service.providers.connect('redis') as RedisClient;

  for (const table of tables) {
    await syncTable(vaultUrl, table, redis);
  }

  scheduleNextPoll(vaultUrl, tables, redis);
});
