/**
 * Entry point — boot order:
 *  1. Connect to MongoDB and RabbitMQ.
 *  2. Bootstrap: ensure indexes, load persisted account state into memory.
 *  3. Subscribe digger to the tables teller needs (trade, instrument).
 *  4. Register mark price listener for PnL recomputation and liquidation checks.
 *  5. Start HTTP server (private REST API + internal control endpoints).
 *  6. Start RabbitMQ consumers (trade fills, instrument cache).
 */
import { type Service, type ExpressServerHandle, type FetchClientHandle, logger } from '@devvir/service-kit';
import SK from './service';
import { bootstrap } from './db/bootstrap';
import { buildRouter } from './rest/routes';
import { startTradeConsumer, startInstrumentConsumer } from './fills';
import { getState } from './store';
import * as positions from './positions';
import * as marginModule from './margin';
import * as db from './db';
import * as publisher from './publisher';

SK.run(async (service: Service) => {
  await service.providers.connect(['mongodb', 'rabbitmq']);

  await bootstrap();
  await subscribeDigger(service.clients.get('digger') as FetchClientHandle);

  // Mark price updates arrive via instrument.update messages. The instrument
  // consumer emits 'markPrice' events on the service so this handler can run
  // without the consumer knowing what happens downstream.
  service.on('markPrice', async (_svc: Service, symbol: string, markPrice: number, replayTs: string) => {
    await handleMarkPrice(symbol, markPrice, replayTs).catch(err =>
      logger.error({ err, symbol }, 'markPrice handler: unhandled error'),
    );
  });

  const api = service.servers.get('api') as ExpressServerHandle;

  api.addRoutes(buildRouter());

  await api.start();

  await startTradeConsumer(service);
  await startInstrumentConsumer(service);
});

// ── Mark price handler ─────────────────────────────────────────────────────────

/**
 * Recompute unrealisedPnl for all accounts with an open position in the symbol,
 * update margin, write to MongoDB, and publish WS events.
 *
 * Runs concurrently across accounts (Promise.all). Each account's updates are
 * sequential to preserve write ordering (memory → DB → WS).
 */
async function handleMarkPrice(symbol: string, markPrice: number, replayTs: string): Promise<void> {
  const { store, instruments } = getState();
  const instrument = instruments.get(symbol);

  if (! instrument) return;

  const affected = [...store.entries()].filter(([, state]) => state.positions.has(symbol));

  await Promise.all(
    affected.map(async ([accountId, state]) => {
      const position = state.positions.get(symbol)!;

      const updatedPosition = positions.recomputeUnrealisedPnl(position, markPrice, instrument);
      state.positions.set(symbol, updatedPosition);

      const updatedMargin = marginModule.applyUnrealisedUpdate(state.margin, state.positions);
      state.margin = updatedMargin;

      await Promise.all([
        db.position.upsert(updatedPosition),
        db.margin.upsert(updatedMargin),
      ]);

      await publisher.publishMarkPriceUpdate(accountId, [updatedPosition], updatedMargin, replayTs);
    }),
  );
}

// ── Digger subscription ────────────────────────────────────────────────────────

/**
 * Subscribe digger to the tables teller consumes. The `digger` fetch client
 * retries transient failures (5xx, network errors) against a still-starting
 * digger; a non-retryable status still surfaces as a thrown error.
 */
async function subscribeDigger(digger: FetchClientHandle): Promise<void> {
  for (const table of ['trade', 'instrument']) {
    const res = await digger.request(`/subscribe/${table}`, { method: 'POST' });

    if (! res.ok) {
      throw new Error(`Failed to subscribe digger to ${table}: HTTP ${res.status}`);
    }

    logger.info({ table }, 'Subscribed digger table');
  }
}
