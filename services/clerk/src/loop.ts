import { logger, type RedisClient } from '@devvir/service-kit';
import { readFileGroups } from './vault';
import { discoverFiles } from './discovery';
import { readProgress } from './progress';
import { publishTask, publishControl } from './publisher';
import { createBoundedBuffer } from './buffer';
import type { Broker, Config, BufferItem, FileWork, BoundedBuffer } from './types';

const POLL_INTERVAL_MS = 60_000;

// ── Top-level ─────────────────────────────────────────────────────────────────

export const runLoop = async (
  config:     Config,
  brokers:    Broker[],
  redis:      RedisClient,
  stopSignal: { stopped: boolean },
): Promise<void> => {
  /**
   * Files completed in this run. Acts as a fast-path filter so the next poll
   * cycle won't re-pick a file while registrar's `'done'` flag is still
   * propagating through Redis. Starts empty — on a cold start, only Redis
   * decides what to skip.
   */
  const completedThisRun = new Set<string>();

  while (! stopSignal.stopped) {
    try {
      const processed = await processNextBatch(config, brokers, redis, completedThisRun);

      if (! processed && ! stopSignal.stopped) {
        logger.debug('Clerk sleeping until next poll');
        await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
      }
    } catch (err) {
      logger.error({ err }, 'Error in clerk poll cycle');
      await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    }
  }
};

/**
 * Discovers vault files and processes every not-yet-done one across the broker
 * pool — one worker per broker. Files marked `done` in Redis OR already
 * completed in this run are skipped. Returns true if at least one file was
 * scheduled.
 */
const processNextBatch = async (
  config:           Config,
  brokers:          Broker[],
  redis:            RedisClient,
  completedThisRun: Set<string>,
): Promise<boolean> => {
  const todo = await pendingWork(config, redis, completedThisRun);

  if (todo.length === 0) return false;

  await runWorkers(config, brokers, todo, completedThisRun);

  return true;
};

// ── Discovery & filtering ─────────────────────────────────────────────────────

type PendingFile = FileWork & { startFrom: number };

/**
 * Returns every file that's known to vault, not marked done in Redis, and not
 * already completed in this run. Each entry includes the absolute msgIndex to
 * resume from (0 for new files).
 */
const pendingWork = async (
  config:           Config,
  redis:            RedisClient,
  completedThisRun: Set<string>,
): Promise<PendingFile[]> => {
  const batches = await discoverFiles(config.vaultUrl, config.tables);

  const candidates: FileWork[] = [];

  for (const { date, tables } of batches) {
    for (const table of tables) {
      candidates.push({ table, date });
    }
  }

  if (candidates.length === 0) return [];

  const progresses = await Promise.all(
    candidates.map(w => readProgress(redis, w.table, w.date)),
  );

  const todo: PendingFile[] = [];

  for (let i = 0; i < candidates.length; i++) {
    const work = candidates[i]!;
    const prog = progresses[i]!;

    if (prog.state === 'done') continue;
    if (completedThisRun.has(workKey(work.table, work.date))) continue;

    todo.push({ ...work, startFrom: prog.startFrom });
  }

  return todo;
};

// ── Worker pool ───────────────────────────────────────────────────────────────

/**
 * Runs one worker per broker, each draining files from a shared queue. Workers
 * exit when the queue is empty. A failure on one file does not abort the
 * worker — it's logged and the file is retried next cycle.
 */
const runWorkers = async (
  config:           Config,
  brokers:          Broker[],
  todo:             PendingFile[],
  completedThisRun: Set<string>,
): Promise<void> => {
  let nextIdx = 0;

  const takeNext = (): PendingFile | undefined => {
    const i = nextIdx++;
    return i < todo.length ? todo[i] : undefined;
  };

  const worker = async (broker: Broker): Promise<void> => {
    while (true) {
      const next = takeNext();
      if (! next) return;

      const { table, date, startFrom } = next;

      try {
        await processFile(config, broker, table, date, startFrom);
        completedThisRun.add(workKey(table, date));
      } catch (err) {
        logger.error({ err, table, date }, 'processFile failed — will retry next cycle');
      }
    }
  };

  await Promise.all(brokers.map(b => worker(b)));
};

// ── Per-file pipeline ─────────────────────────────────────────────────────────

const processFile = async (
  config:    Config,
  broker:    Broker,
  table:     string,
  date:      string,
  startFrom: number,
): Promise<void> => {
  logger.info({ table, date, startFrom }, 'Processing vault file');

  const buffer = createBoundedBuffer<BufferItem>(config.readBufferHigh, config.readBufferLow);

  const [ totalGroups ] = await Promise.all([
    readTask(config, table, date, buffer, startFrom),
    publishTask(broker, table, date, buffer),
  ]);

  await publishControl(broker, table, date, totalGroups - 1);

  logger.info({ table, date, totalGroups }, 'Vault file processed');
};

/**
 * Streams the vault file and pushes raw NDJSON lines into the buffer. Closes
 * the buffer in `finally` so PublishTask sees the end-of-stream signal whether
 * the read succeeded or failed.
 */
const readTask = async (
  config:    Config,
  table:     string,
  date:      string,
  buffer:    BoundedBuffer<BufferItem>,
  startFrom: number,
): Promise<number> => {
  try {
    return await readFileGroups(config.vaultUrl, table, date, async (line, msgIndex) => {
      await buffer.push({ line, msgIndex });
    }, startFrom);
  } finally {
    buffer.close();
  }
};

const workKey = (table: string, date: string): string => `${table}:${date}`;

// ── Test exports ──────────────────────────────────────────────────────────────

export const _test_processNextBatch = processNextBatch;
