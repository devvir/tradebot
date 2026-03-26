import { createDatabase } from '@devvir/bitmex-database';
import { SKFactory } from '@tradebot/utils';

const state = {
  database: createDatabase(),
  counters: {} as Record<string, number>,
  tables:   new Set<string>(),
} as const;

export default SKFactory({
  name: 'snapshots',
  rabbitmq: { topology: { queues: { snapshots: {} } } },
  trackMessages: true,
  }).declare({ state });
