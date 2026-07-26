/**
 * Trader orchestrator: the main loop that ties strategy, planner, and executor
 * together against the live data cache.
 *
 * Each tick:
 *   1. Read the latest snapshot from the cache
 *   2. Ask the strategy what orders it wants
 *   3. Translate to fully-specified BitMEX orders (rounding, lot sizes)
 *   4. Converge against the locally-tracked managed-orders list
 *   5. Apply amend/create/cancel via REST and update the managed list
 *
 * Tick scheduling: self-rescheduling. The next tick is queued only after the
 * current one finishes, so a slow tick (REST retries) never overlaps with
 * itself.
 *
 * clOrdID format: `tb_<SYMBOL>_<6-digit-zero-padded-sequence>`. The sequence
 * is seeded from the highest existing managed order on startup so a quick
 * restart can't reuse an ID that's still resting on the book.
 */

import { logger } from '@devvir/service-kit';
import type { Order } from '../types';
import type { Strategy } from '../strategies';
import type { DataCache } from '../source';
import type { RestClient } from '../rest';
import { converge, filterActiveOrders, applyConvergeResult } from '../executor';
import type { ApplyContext } from '../executor';
import { translateOrders } from '../planner';
import type { StrategyConfig } from './types';
import { applyToOrderList, buildClOrdID, seedSequence } from './managed-orders';

export class Orchestrator {
  private readonly cache:      DataCache;
  private readonly restClient: RestClient;

  private strategy:      Strategy | null = null;
  private config:        StrategyConfig | null = null;
  private managedOrders: Order[] = [];
  private orderSeq =     0;
  private running =      false;
  private tickTimer:     NodeJS.Timeout | null = null;

  constructor(cache: DataCache, restClient: RestClient) {
    this.cache      = cache;
    this.restClient = restClient;
  }

  setStrategy(strategy: Strategy, config: StrategyConfig): void {
    this.strategy = strategy;
    this.config   = config;
  }

  async start(): Promise<void> {
    if (! this.strategy || ! this.config) {
      throw new Error('Strategy not set — call setStrategy() before start()');
    }

    await this.seedManagedOrders();

    this.running = true;
    await this.tick();
    this.scheduleNextTick();
  }

  async stop(): Promise<void> {
    this.running = false;

    if (this.tickTimer) {
      clearTimeout(this.tickTimer);
      this.tickTimer = null;
    }
  }

  isRunning(): boolean {
    return this.running;
  }

  // ---- Private -----------------------------------------------------------

  private async seedManagedOrders(): Promise<void> {
    const symbol = this.config!.symbol;

    try {
      const existing = await this.restClient.getOrders(symbol);

      this.managedOrders = filterActiveOrders(existing, symbol);
      this.orderSeq      = seedSequence(this.managedOrders, symbol);

      logger.info({ count: this.managedOrders.length, orderSeq: this.orderSeq }, 'Seeded managed orders from REST');
    } catch (err) {
      logger.warn({ err }, 'Failed to seed managed orders — starting empty');
      this.managedOrders = [];
      this.orderSeq      = 0;
    }
  }

  private nextClOrdID(): string {
    const next = buildClOrdID(this.config!.symbol, this.orderSeq);

    this.orderSeq = next.seq;

    return next.id;
  }

  private scheduleNextTick(): void {
    if (! this.running) return;

    this.tickTimer = setTimeout(() => {
      this.tick()
        .catch((err: unknown) => logger.error({ err }, 'Orchestrator tick error'))
        .finally(() => this.scheduleNextTick());
    }, this.config!.tickIntervalMs);
  }

  private async tick(): Promise<void> {
    if (! this.strategy || ! this.config) return;

    const symbol  = this.config.symbol;
    const data    = this.cache.getAll();
    const pseudo  = this.strategy.decide(data);
    const planned = translateOrders(pseudo, symbol, data.instrument);
    const live    = filterActiveOrders(this.managedOrders, symbol);
    const result  = converge(planned, live, this.config.amendThreshold ?? 0);

    if (result.amends.length === 0 && result.creates.length === 0 && result.cancels.length === 0) {
      return;
    }

    // Pre-allocate clOrdIDs for all creates so positional matching is stable
    const creates = result.creates.map((c) => ({
      order:   c.order,
      clOrdID: this.nextClOrdID(),
    }));

    const ctx: ApplyContext = {
      desired:     planned,
      live,
      nextClOrdID: () => this.nextClOrdID(),
    };

    const applied = await applyConvergeResult(result, creates, this.restClient, ctx);

    this.managedOrders = applyToOrderList(this.managedOrders, applied);

    logger.info(applied.summary, 'Execution complete');
  }
}
