/**
 * Bootstrap: ensure indexes and load persisted state into memory on startup.
 *
 * Indexes are created with { background: false } — blocking on first run,
 * instant no-op on subsequent runs when they already exist.
 *
 * Load order matters: margin first (account existence), then orders and
 * positions. All non-terminal orders are loaded (New, PartiallyFilled).
 */
import { logger } from '@devvir/service-kit';
import { getMongo, getState, getConfig } from '../store';
import type { OrderDoc, PositionDoc, MarginDoc, AccountState } from '../types';

const ACTIVE_STATUSES = ['New', 'PartiallyFilled'];

export async function bootstrap(): Promise<void> {
  const mongo  = getMongo();
  const config = getConfig();
  const db     = mongo.db(config.database);

  logger.info('Bootstrap: ensuring indexes...');
  await ensureIndexes(db);

  logger.info('Bootstrap: loading state from MongoDB...');
  await loadState(db);

  logger.info({ accounts: getState().store.size }, 'Bootstrap: complete');
}

// ── Indexes ────────────────────────────────────────────────────────────────────

async function ensureIndexes(db: ReturnType<typeof getMongo>['db'] extends (...a: any[]) => infer R ? R : never): Promise<void> {
  await Promise.all([
    db.collection('order').createIndex({ accountId: 1, clOrdID: 1 },       { unique: true, background: false }),
    db.collection('order').createIndex({ accountId: 1, symbol: 1, ordStatus: 1 }, { background: false }),
    db.collection('execution').createIndex({ accountId: 1, timestamp: -1 }, { background: false }),
    db.collection('position').createIndex({ accountId: 1, symbol: 1, strategy: 1 }, { unique: true, background: false }),
    db.collection('margin').createIndex({ accountId: 1 },                   { unique: true, background: false }),
  ]);
}

// ── State load ─────────────────────────────────────────────────────────────────

async function loadState(db: any): Promise<void> {
  const { store } = getState();

  const [margins, orders, positions] = await Promise.all([
    db.collection('margin').find({}).toArray() as Promise<MarginDoc[]>,
    db.collection('order').find({ ordStatus: { $in: ACTIVE_STATUSES } }).toArray() as Promise<OrderDoc[]>,
    db.collection('position').find({}).toArray() as Promise<PositionDoc[]>,
  ]);

  // Build account state from margin docs (account existence is determined by margin)
  for (const marginDoc of margins) {
    const accountState: AccountState = {
      margin:    marginDoc,
      orders:    new Map(),
      positions: new Map(),
    };

    store.set(marginDoc.accountId, accountState);
  }

  // Load active orders into their accounts
  for (const order of orders) {
    const accountState = store.get(order.accountId);

    if (! accountState) {
      logger.warn({ accountId: order.accountId }, 'Bootstrap: order with no margin record — skipping');
      continue;
    }

    accountState.orders.set(order.orderID, order);
  }

  // Load positions into their accounts
  for (const position of positions) {
    const accountState = store.get(position.accountId);

    if (! accountState) {
      logger.warn({ accountId: position.accountId }, 'Bootstrap: position with no margin record — skipping');
      continue;
    }

    accountState.positions.set(position.symbol, position);
  }

  logger.info({
    accounts: store.size,
    orders:   orders.length,
    positions: positions.length,
  }, 'Bootstrap: state loaded');
}
