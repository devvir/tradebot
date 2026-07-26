/**
 * The sole owner of progress storage. Other modules call the semantic API
 * (`list`, `listDone`, `get`, `markProgress`, `markDone`) and never touch
 * Redis directly. The on-disk format and key shape are private — Redis
 * could be swapped for Mongo or filesystem without a single line outside
 * this file changing.
 */

import { registry } from '@devvir/service-kit';
import type { BitmexTable } from '@tradebot/types';
import type { RedisClient } from '../types';

const PREFIX = 'farm';

export interface Entry {
  table:    BitmexTable;
  date:     string;
  state:    'pending' | 'done';
  messages: number;
}

// ── Public API ────────────────────────────────────────────────────────────────

export const list = async (): Promise<Entry[]> => {
  const c    = client();
  const keys = await keysMatching(c, `${PREFIX}:*`);

  if (keys.length === 0) return [];

  const values = await c.mGet(keys);
  const out:   Entry[] = [];

  for (let i = 0; i < keys.length; i++) {
    const v = values[i];

    if (v === null || v === undefined) continue;

    const parsedKey = parseKey(keys[i]!);

    if (! parsedKey) continue;

    out.push({ ...parsedKey, ...decode(v) });
  }

  return out;
};

export const listDone = async (): Promise<Entry[]> => {
  const all = await list();

  return all.filter(e => e.state === 'done');
};

export const get = async (table: BitmexTable, date: string): Promise<Entry | null> => {
  const v = await client().get(key(table, date));

  if (v === null) return null;

  return { table, date, ...decode(v) };
};

export const markProgress = (
  table:    BitmexTable,
  date:     string,
  messages: number,
): Promise<void> => writeMax(table, date, { state: 'pending', messages });

export const markDone = (
  table:    BitmexTable,
  date:     string,
  messages: number,
): Promise<void> => writeMax(table, date, { state: 'done', messages });

// ── Private ───────────────────────────────────────────────────────────────────

/** Single writer (one farmer instance), so read-then-set is safe; the rule is just "never regress". */
const writeMax = async (
  table: BitmexTable,
  date:  string,
  next:  { state: 'pending' | 'done'; messages: number },
): Promise<void> => {
  const k       = key(table, date);
  const raw     = await client().get(k);
  const current = raw === null ? null : decode(raw);

  if (current && rank(current) >= rank(next)) return;

  await client().set(k, encode(next.state, next.messages));
};

const rank = (entry: { state: 'pending' | 'done'; messages: number }): number =>
  entry.state === 'done' ? Infinity : entry.messages;

let cached: RedisClient | null = null;

const client = (): RedisClient => {
  if (! cached) {
    cached = registry.get('farmer').providers.get('redis') as RedisClient;

    if (! cached) throw new Error('Redis is not connected');
  }

  return cached;
};

const key = (table: BitmexTable, date: string): string => `${PREFIX}:${table}:${date}`;

const parseKey = (k: string): { table: BitmexTable; date: string } | null => {
  const parts = k.split(':');

  if (parts.length !== 3)    return null;
  if (parts[0] !== PREFIX)   return null;

  return { table: parts[1] as BitmexTable, date: parts[2]! };
};

const encode = (state: 'pending' | 'done', messages: number): string =>
  state === 'done' ? `done:${messages}` : String(messages);

const decode = (raw: string): { state: 'pending' | 'done'; messages: number } => {
  if (raw.startsWith('done:')) return { state: 'done',    messages: parseInt(raw.slice(5), 10) };

  return                            { state: 'pending', messages: parseInt(raw, 10) };
};

const keysMatching = async (c: RedisClient, pattern: string): Promise<string[]> => {
  const keys: string[] = [];

  for await (const k of c.scanIterator({ MATCH: pattern, COUNT: 500 })) {
    keys.push(k);
  }

  return keys;
};

// ── Test-only exports ─────────────────────────────────────────────────────────

export const _test_PREFIX       = PREFIX;
export const _test_encode       = encode;
export const _test_decode       = decode;
export const _test_resetClient  = (): void => { cached = null; };
