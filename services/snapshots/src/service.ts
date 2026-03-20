import { SKFactory } from '@tradebot/utils';
import { createDatabase } from '@devvir/bitmex-database';

export default SKFactory({
  name: 'snapshots',
  rabbitmq: { topology: { queues: { snapshots: {} } } },
  trackMessages: true,
}).declare({ state: { database: createDatabase(), counters: {}, tables: new Set<string>() } });
