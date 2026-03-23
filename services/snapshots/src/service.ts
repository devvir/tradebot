import { createDatabase, type Database } from '@devvir/bitmex-database';
import { SKFactory } from '@tradebot/utils';
import config from './config';

export default SKFactory({
  name: 'snapshots',
  rabbitmq: { topology: { queues: { snapshots: {} } } },
  trackMessages: true,
}).declare({
  config,
  state: {
    database:        createDatabase(),
    counters:        {} as Record<string, number>,
    tables:          new Set<string>(),
    privateDBs:      new Map<string, Database>(),
    privateTables:   new Map<string, Set<string>>(),
    privateCounters: new Map<string, Record<string, number>>(),
  },
});
