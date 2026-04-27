import { logger, Broker, type RedisClient } from '@devvir/service-kit';
import { listTables, listFiles, readFileGroups, isWsMessage } from './vault';
import { isDone, getOffset, setOffset, markDone } from './progress';
import type { Config } from './types';

type Gate = () => Promise<void>;

const OFFSET_CHECKPOINT  = 500;
const PUBLISH_BATCH_SIZE = 500;
const POLL_INTERVAL_MS   = 60_000;

export const runOnce = async (
  vaultUrl: string,
  broker: Broker,
  redis: RedisClient,
  gate: Gate,
): Promise<void> => {
  const tables = await listTables(vaultUrl);

  const byDate = new Map<string, { table: string; state: string }[]>();

  await Promise.all(tables.map(async (table) => {
    const files = await listFiles(vaultUrl, table);
    if (! files) return;
    for (const [date, state] of Object.entries(files)) {
      const entry = byDate.get(date) ?? [];
      entry.push({ table, state });
      byDate.set(date, entry);
    }
  }));

  for (const date of [...byDate.keys()].sort()) {
    await Promise.all(
      byDate.get(date)!.map(({ table, state }) =>
        processFile(vaultUrl, table, date, state, broker, redis, gate),
      ),
    );
  }
};

export const runLoop = async (
  config: Config,
  broker: Broker,
  redis:  RedisClient,
  gate:   Gate,
  stopSignal: { stopped: boolean },
): Promise<void> => {
  const { vaultUrl } = config;

  while (! stopSignal.stopped) {
    try {
      await runOnce(vaultUrl, broker, redis, gate);
    } catch (err) {
      logger.error({ err }, 'Error in clerk poll cycle');
    }

    logger.debug('Clerk sleeping until next poll');

    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
};

const processFile = async (
  vaultUrl: string,
  table: string,
  date: string,
  state: string,
  broker: Broker,
  redis: RedisClient,
  gate: Gate,
): Promise<void> => {
  if (await isDone(redis, table, date)) return;

  const startFrom = await getOffset(redis, table, date);

  logger.info({ table, date, startFrom }, 'Processing vault file');

  const outExchange = broker.getExchange()!;

  const pending: Promise<void>[] = [];

  const flush = async (): Promise<void> => {
    if (pending.length === 0) return;
    await Promise.all(pending);
    pending.length = 0;
  };

  let publishedCount = 0;

  const totalGroups = await readFileGroups(vaultUrl, table, date, async (rows, msgIndex) => {
    await gate();

    const routingKey = isWsMessage(rows) ? 'message' : 'record';

    if (publishedCount === 0) {
      logger.debug({ table, date, msgIndex, routingKey }, 'First item received from vault');
    }

    pending.push(outExchange.publish(rows, routingKey, {
      headers: {
        'x-table':     table,
        'x-date':      date,
        'x-msg-index': msgIndex,
      },
    }));

    publishedCount++;

    if (pending.length >= PUBLISH_BATCH_SIZE) {
      await flush();
    }

    if ((msgIndex + 1) % OFFSET_CHECKPOINT === 0) {
      // Flush before persisting the offset so we never advance the Redis
      // checkpoint past messages still in the publish queue. Without this,
      // a crash between setOffset and the next flush would silently drop
      // those in-flight messages on resume (vault would skip past them).
      await flush();

      logger.debug({ table, date, msgIndex, publishedCount }, 'Clerk publish checkpoint');
      await setOffset(redis, table, date, msgIndex + 1);
    }
  }, startFrom);

  logger.debug({ table, date, totalGroups, publishedCount, startFrom }, 'readFileGroups complete');

  await flush();

  if (state === 'closed') {
    await markDone(redis, table, date);
  } else {
    await setOffset(redis, table, date, totalGroups);
  }

  logger.info({ table, date, totalGroups }, 'Vault file processed');
};
