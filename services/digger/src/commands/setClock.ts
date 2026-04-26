import { logger, RabbitMQ, type Broker } from '@devvir/service-kit';
import type { MongoClient } from 'mongodb';
import * as clock from '../clock';
import * as snapshots from '../snapshots';
import { subscribe } from './subscribe';
import type { Config, State } from '../types';

/**
 * Set (or change) the replay clock — the session-level seek operation.
 *
 * Why this is a session-level command, not a subscribe parameter:
 *
 * Different BitMEX tables have data from different start dates with varying
 * confidence. trade/quote go back to 2014; synthetic instrument from 2016;
 * reliable instrument from 2019; synthetic orderBookL2 from 2019; real
 * continuous L2 from 2026. A bot family chooses one starting era based on
 * what data quality their strategy needs, then runs many subscriptions and
 * REST queries from that fixed point. The clock is set once when the family
 * boots, rarely changed.
 *
 * Tying the clock to a per-table parameter would let two bots subscribed to
 * the same digger pull data from different eras into the same exchange — a
 * mess. The clock is one shared cursor; everyone reads from it.
 *
 * Sequence on `POST /set-clock?timestamp=...`:
 *   1. Pause the streaming engine — no new publishes, no new fetches.
 *   2. Brief settle delay so any in-flight publish completes.
 *   3. Purge the watched queues (DIGGER_WAIT_IF) — discard every old-clock
 *      message that's still ready in the broker. We don't wait for consumers
 *      to process them: stale data is worse than no data once the clock has
 *      moved, so we drop it ourselves.
 *   4. Set the clock to the new timestamp.
 *   5. Reset the snapshots accumulator — its state was for the old position.
 *   6. Re-prime every existing subscription (drop buffer, fresh partial,
 *      fresh initial fetch) at the new clock.
 *   7. Resume the stream loop. New data flows from the new clock onwards.
 *   8. Return 201.
 *
 * Returning 201 means: queues are empty, clock is updated, fresh data is
 * about to start flowing. Clients can resume consuming with confidence that
 * the next message they see is on the new clock.
 *
 * Note: in-flight unacked messages already delivered to consumers stay with
 * those consumers — purge only clears the broker-side ready buffer. Consumer
 * services are responsible for dropping any in-process state when they
 * observe a clock-change boundary (e.g., a future orchestrator that resets
 * bot positions and wallets when stepping between training periods).
 */

/** Brief sleep after pausing to let any in-flight publish complete. */
const PAUSE_SETTLE_MS = 200;

// ── Public API ────────────────────────────────────────────────────────────────

export const setClock = async (
  timestamp: number,
  state:     State,
  config:    Config,
  mongo:     MongoClient,
  broker:    Broker,
): Promise<void> => {
  if (! Number.isFinite(timestamp) || timestamp <= 0) {
    throw httpError(400, `Invalid timestamp: ${timestamp}`);
  }

  logger.info({ timestamp: new Date(timestamp).toISOString() }, 'set-clock: starting');

  state.isPaused = true;

  try {
    await new Promise(resolve => setTimeout(resolve, PAUSE_SETTLE_MS));

    if (config.waitIfQueues) {
      await RabbitMQ.purgeQueues(broker.getUrl(), Object.keys(config.waitIfQueues));
    }

    clock.set(timestamp);
    snapshots.reset();

    await reprimeSubscriptions(state, config, mongo, broker);
  } finally {
    state.isPaused = false;
  }

  logger.info({ timestamp: new Date(timestamp).toISOString() }, 'set-clock: done');
};

// ── Internal ──────────────────────────────────────────────────────────────────

const reprimeSubscriptions = async (
  state:  State,
  config: Config,
  mongo:  MongoClient,
  broker: Broker,
): Promise<void> => {
  const tables = Array.from(state.subscriptions.keys());

  state.subscriptions.clear();
  state.buffers.clear();

  for (const table of tables) {
    await subscribe(table, state, config, mongo, broker);
  }
};

const httpError = (status: number, message: string): Error =>
  Object.assign(new Error(message), { httpStatus: status });
