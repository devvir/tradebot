/**
 * Core orchestrator: main loop that ties everything together.
 *
 * Tracks managed orders locally (seeded from REST on startup) so the converge
 * algorithm can produce a minimal changeset each tick without needing a private
 * WS subscription.
 *
 * clOrdID format: tb_<SYMBOL>_<6-digit-zero-padded-sequence>
 *   e.g. tb_XBTUSD_000001
 */

import { logger } from '@devvir/service-kit';
import type { Order } from '../types';
import type { Strategy } from '../strategies';
import type { DataCache } from '../source';
import type { RestClient } from '../executor';
import { converge, filterActiveOrders, applyConvergeResult } from '../executor';
import type { ApplyContext, ApplyResult } from '../executor';
import { translateOrders } from '../planner';
import type { StrategyConfig } from './types';

export class Orchestrator {
  private strategy:      Strategy | null = null;
  private config:        StrategyConfig | null = null;
  private cache:         DataCache;
  private restClient:    RestClient;
  private running =      false;
  private loopInterval:  NodeJS.Timeout | null = null;
  private managedOrders: Order[] = [];
  private orderSeq =     0;

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

    // Seed managed orders from the exchange so we don't orphan orders on restart
    try {
      const existing = await this.restClient.getOrders(this.config.symbol);

      this.managedOrders = filterActiveOrders(existing, this.config.symbol);

      logger.info({ count: this.managedOrders.length }, 'Seeded managed orders from REST');
    } catch (err) {
      logger.warn({ err }, 'Failed to seed managed orders — starting empty');
    }

    this.running = true;

    this.loopInterval = setInterval(() => {
      this.tick().catch((err: unknown) => logger.error({ err }, 'Orchestrator tick error'));
    }, this.config.tickIntervalMs);

    // First tick immediately so we don't wait a full interval on startup
    await this.tick();
  }

  async stop(): Promise<void> {
    this.running = false;

    if (this.loopInterval) {
      clearInterval(this.loopInterval);
      this.loopInterval = null;
    }
  }

  isRunning(): boolean {
    return this.running;
  }

  // ---- Private -----------------------------------------------------------

  private nextClOrdID(): string {
    this.orderSeq += 1;

    return `tb_${this.config!.symbol}_${String(this.orderSeq).padStart(6, '0')}`;
  }

  private async tick(): Promise<void> {
    if (! this.strategy || ! this.config) {
      return;
    }

    try {
      const data    = this.cache.getAll();
      const pseudo  = this.strategy.decide(data);
      const planned = translateOrders(pseudo, this.config.symbol, data.instrument);
      const live    = filterActiveOrders(this.managedOrders, this.config.symbol);
      const result  = converge(planned, live, this.config.amendThreshold ?? 0);

      if (result.amends.length === 0 && result.creates.length === 0 && result.cancels.length === 0) {
        return;
      }

      // Assign clOrdIDs to all creates upfront (before any async calls)
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
    } catch (err) {
      logger.error({ err }, 'Orchestrator tick error');
    }
  }
}

/** Update the managed order list from a completed apply result. */
function applyToOrderList(current: Order[], applied: ApplyResult): Order[] {
  let orders = [...current];

  // Add newly created orders
  for (const order of applied.created) {
    orders.push(order);
  }

  // Replace amended orders with the updated version returned by the exchange
  for (const order of applied.amended) {
    orders = orders.map((o) => (o.orderID === order.orderID ? order : o));
  }

  // Remove cancelled (and stale-fallback) orders
  const cancelledSet = new Set(applied.cancelledIds);

  orders = orders.filter((o) => ! cancelledSet.has(o.orderID));

  return orders;
}
