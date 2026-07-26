/**
 * Boundary: publish private WS events to the topic:replay exchange.
 *
 * All messages carry x-account-id so the ws service routes them to the correct
 * authenticated client. The replay-clock timestamp of the triggering event is
 * used for x-bitmex-published-at, keeping all messages on a single consistent
 * clock — mixing wall time with replay time would make the stream incoherent.
 */
import { logger } from '@devvir/service-kit';
import { getConfig, getBroker } from '../store';
import type { Broker } from '@devvir/service-kit';
import type { OrderDoc, ExecutionDoc, PositionDoc, MarginDoc } from '../types';

const messageCounters = new Map<string, number>();

export async function publishFill(
  accountId:  string,
  order:      OrderDoc,
  execution:  ExecutionDoc,
  position:   PositionDoc,
  margin:     MarginDoc,
  replayTs:   string,
): Promise<void> {
  await Promise.all([
    publish(accountId, 'execution', 'insert', [execution], replayTs),
    publish(accountId, 'order',     'update',  [order],     replayTs),
    publish(accountId, 'position',  'update',  [position],  replayTs),
    publish(accountId, 'margin',    'update',  [margin],    replayTs),
  ]);
}

export async function publishPartial(
  accountId: string,
  table:     string,
  data:      unknown[],
  replayTs:  string,
): Promise<void> {
  await publish(accountId, table, 'partial', data, replayTs);
}

export async function publishMarkPriceUpdate(
  accountId: string,
  positions: PositionDoc[],
  margin:    MarginDoc,
  replayTs:  string,
): Promise<void> {
  await Promise.all([
    publish(accountId, 'position', 'update', positions, replayTs),
    publish(accountId, 'margin',   'update', [margin],  replayTs),
  ]);
}

// ── Private helpers ────────────────────────────────────────────────────────────

async function publish(
  accountId:  string,
  table:      string,
  action:     string,
  data:       unknown[],
  replayTs:   string,
): Promise<void> {
  const broker   = getBroker() as Broker;
  const exchange = broker.getExchange();

  if (! exchange) {
    logger.warn({ table, accountId }, 'Publisher: exchange not available — message dropped');
    return;
  }

  const { workerUuid } = getConfig();
  const count = (messageCounters.get(accountId) ?? 0) + 1;
  messageCounters.set(accountId, count);

  const payload = { table, action, data };

  try {
    await exchange.publish(
      Buffer.from(JSON.stringify(payload)),
      `${table}.${action}`,
      {
        contentType: 'application/json',
        headers: {
          'x-account-id':          accountId,
          'x-worker-uuid':         workerUuid,
          'x-message-count':       String(count),
          'x-bitmex-published-at': replayTs,
        },
      },
    );
  } catch (err) {
    logger.error({ err, table, action, accountId }, 'Publisher: failed to publish message');
  }
}
