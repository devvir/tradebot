import type { RedisClient } from '@devvir/service-kit';

const key = (table: string, date: string): string => `clerk_progress:${table}:${date}`;

// Returns the number of message groups already published for a file.
// Returns 0 if the file has never been processed (or is marked done, which
// means the caller should have checked isDone first).
export const getOffset = async (
  redis: RedisClient,
  table: string,
  date: string,
): Promise<number> => {
  const val = await redis.get(key(table, date));
  if (val === null || val === 'done') return 0;
  return parseInt(val, 10);
};

// Returns true if the file has been fully processed and sealed.
// Only closed files are ever marked done.
export const isDone = async (
  redis: RedisClient,
  table: string,
  date: string,
): Promise<boolean> => {
  return (await redis.get(key(table, date))) === 'done';
};

// Persists the current offset (number of groups published from file start).
export const setOffset = async (
  redis: RedisClient,
  table: string,
  date: string,
  offset: number,
): Promise<void> => {
  await redis.set(key(table, date), String(offset));
};

// Marks a closed file as permanently done — will never be revisited.
export const markDone = async (
  redis: RedisClient,
  table: string,
  date: string,
): Promise<void> => {
  await redis.set(key(table, date), 'done');
};
