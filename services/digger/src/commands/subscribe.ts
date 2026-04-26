import { logger, type Broker } from '@devvir/service-kit';
import type { MongoClient } from 'mongodb';
import { createBuffer, initialFill, publishPartial } from '../websocket';
import { TABLE_HANDLERS, isSupportedTable } from '../tables';
import * as clock from '../clock';
import * as snapshots from '../snapshots';
import { backfillSnapshot } from './backfill';
import type { BitmexTable, Config, State, Subscription, TableBuffer, WsMessage } from '../types';

/**
 * The control plane. Three commands:
 *
 *   subscribe   — start replaying a table from the current replay clock.
 *                 Sends a partial, then the stream loop picks it up.
 *   unsubscribe — stop replaying a table. Drops its buffer.
 *   resubscribe — refresh a single table: drop its buffer, fetch fresh, send a
 *                 new partial. Does NOT change the clock — use `set-clock` for
 *                 session-wide seeking.
 *
 * The streaming engine itself never starts/stops; it idles when no buffers have
 * data. Subscriptions just feed it.
 */

// ── Subscribe ─────────────────────────────────────────────────────────────────

export const subscribe = async (
  table:  string,
  state:  State,
  config: Config,
  mongo:  MongoClient,
  broker: Broker,
): Promise<void> => {
  if (! isSupportedTable(table)) {
    throw httpError(400, `Unknown table: ${table}`);
  }

  if (state.subscriptions.has(table)) {
    logger.warn({ table }, 'Already subscribed — use resubscribe to refresh');
    return;
  }

  const buffer = registerSubscription(table, state);
  const X = clock.fetch();

  if (X === null) {
    logger.info({ table }, 'Subscribed (clock not set — buffer idles until set-clock)');
    return;
  }

  await sendPartial(table, X, buffer, config, mongo, broker);
  await initialFill(buffer, config, mongo);

  logger.info({ table, X: new Date(X).toISOString() }, 'Subscribed');
};

// ── Unsubscribe ───────────────────────────────────────────────────────────────

export const unsubscribe = (table: string, state: State): void => {
  if (! state.subscriptions.has(table)) {
    logger.warn({ table }, 'Unsubscribe: not subscribed');
    return;
  }

  state.subscriptions.delete(table);
  state.buffers.delete(table);

  logger.info({ table }, 'Unsubscribed');
};

// ── Resubscribe (refresh — does not move the clock) ───────────────────────────

export const resubscribe = async (
  table:  string,
  state:  State,
  config: Config,
  mongo:  MongoClient,
  broker: Broker,
): Promise<void> => {
  unsubscribe(table, state);
  await subscribe(table, state, config, mongo, broker);
};

// ── Internal ──────────────────────────────────────────────────────────────────

const registerSubscription = (table: string, state: State): TableBuffer => {
  const subscription: Subscription = { table: table as BitmexTable };
  const buffer = createBuffer(table as BitmexTable);

  state.subscriptions.set(table, subscription);
  state.buffers.set(table, buffer);

  return buffer;
};

/**
 * Emit the table's `partial`. Resolution order:
 *   1. Snapshots accumulator — current state if the table is already warm
 *      (the stream has been running and feeding it).
 *   2. WS-origin cold start — replay the most recent stored partial and any
 *      subsequent deltas through snapshots, then read the result. Also seeds
 *      `buffer.cursor` so the first stream fetch starts after X.
 *   3. REST-origin cold start — emit the handler's static partial (schema
 *      only; these tables are flat record streams without stored partials).
 *
 * In every case the partial is also fed into the accumulator so the table is
 * warm for any subsequent subscribers in this session.
 */
const sendPartial = async (
  table:  BitmexTable,
  X:      number,
  buffer: TableBuffer,
  config: Config,
  mongo:  MongoClient,
  broker: Broker,
): Promise<void> => {
  const partial = await pickPartial(table, X, buffer, config, mongo);

  if (! partial) {
    logger.warn({ table, X }, 'No partial available for cold subscribe — skipping');
    return;
  }

  await publishPartial(partial, broker, config);
  snapshots.feed(partial);
};

const pickPartial = async (
  table:  BitmexTable,
  X:      number,
  buffer: TableBuffer,
  config: Config,
  mongo:  MongoClient,
): Promise<WsMessage | null> => {
  const warm = snapshots.buildSnapshot(table);

  if (warm) return warm;

  const handler = TABLE_HANDLERS[table];

  if (! handler) return null;

  if (handler.origin === 'ws') {
    const ok = await backfillSnapshot(table, X, buffer, config, mongo);

    return ok ? snapshots.buildSnapshot(table) : null;
  }

  return handler.partial;
};

const httpError = (status: number, message: string): Error =>
  Object.assign(new Error(message), { httpStatus: status });
