import { logger, type Broker } from '@devvir/service-kit';
import type { MongoClient } from 'mongodb';
import * as clock from '../clock';
import * as snapshots from '../snapshots';
import { TABLE_HANDLERS } from '../tables';
import { dequeue, needsRefetch } from './buffer';
import { triggerFetch } from './fetcher';
import { pickNext, allExhausted, type NextCandidate } from './merge';
import { publish } from './publisher';
import type { Config, State } from '../types';

/**
 * The streaming loop — the heart of digger.
 *
 * Reads like a story:
 *   1. Pick the next message globally (k-way merge across all buffers).
 *   2. Emit it: publish to RabbitMQ, feed snapshots, advance the clock.
 *   3. Top up the buffer if it's running low.
 *
 * Edge cases live in their own well-named helpers (waitForData, allExhausted).
 */

const POLL_WHILE_EMPTY_MS = 10;

// ── Public API ────────────────────────────────────────────────────────────────

export const runStream = async (
  state:  State,
  config: Config,
  mongo:  MongoClient,
  broker: Broker,
): Promise<void> => {
  logger.info('Stream started');

  while (! state.isShuttingDown) {
    if (state.isPaused) {
      await waitForData();
      continue;
    }

    const next = pickNext(state);

    if (! next) {
      if (allExhausted(state)) break;

      await waitForData();
      continue;
    }

    await emit(next, broker, config);
    refillIfNeeded(next, state, config, mongo);
  }

  logger.info('Stream stopped');
};

// ── Internal ──────────────────────────────────────────────────────────────────

/**
 * Publish the head of the chosen buffer, feed the snapshots accumulator, and
 * advance the replay clock. One buffer slot may produce multiple outbound
 * messages (e.g. trade sweep reconstruction).
 */
const emit = async (next: NextCandidate, broker: Broker, config: Config): Promise<void> => {
  const handler = TABLE_HANDLERS[next.table]!;
  const result  = handler.take(next.buffer.entries);

  if (! result) return;

  dequeue(next.buffer, result.consumed);

  for (const msg of result.messages) {
    await publish(msg, broker, config);
    snapshots.feed(msg.payload);
    clock.update(msg.timestamp);
  }
};

const refillIfNeeded = (
  next:   NextCandidate,
  state:  State,
  config: Config,
  mongo:  MongoClient,
): void => {
  if (! state.subscriptions.has(next.table)) return;
  if (! needsRefetch(next.buffer, config.bufferLowWatermark)) return;

  triggerFetch(next.buffer, config, mongo);
};

/**
 * Brief pause when every buffer is momentarily empty but at least one is still
 * fetching. A condition variable would be more elegant; the 10ms poll is fine.
 */
const waitForData = (): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, POLL_WHILE_EMPTY_MS));
