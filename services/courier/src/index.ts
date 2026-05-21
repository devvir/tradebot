import type { FetchClientHandle, RedisClient } from '@devvir/service-kit';
import SK from './service';
import { syncTable, scheduleNextPoll } from './loop';
import type { Config } from './types';

SK.run(async (service) => {
  const { tables } = service.config() as Config;
  const vault      = service.clients.get('vault') as FetchClientHandle;
  const redis      = await service.providers.connect('redis') as RedisClient;

  for (const table of tables) {
    await syncTable(vault, table, redis);
  }

  scheduleNextPoll(vault, tables, redis);
});
