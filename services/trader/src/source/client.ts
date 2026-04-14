/**
 * HTTP REST client for the exchange REST service.
 *
 * Ports the production-grade behaviour from services/executor/rest.ts:
 *   - Rate limit awareness (x-ratelimit-remaining header)
 *   - Retry with linear backoff for network failures and 5xx responses
 *   - Stale amend detection (returns null on 404 / "Not Found" 400)
 *   - Batch cancel
 *
 * Auth: adds x-account-id so the proxy service (bouncer) can sign and forward
 * requests to the exchange. No API key handling here.
 */

import { logger } from '@devvir/service-kit';
import type { Order } from '../types';
import type { OrderPlan } from '../planner/types';
import type { RestClient } from '../executor/types';

const MAX_RETRIES       = 3;
const RETRY_BASE_MS     = 500;
const RATE_LIMIT_BUFFER = 10;

export class HttpRestClient implements RestClient {
  private readonly baseUrl:   string;
  private readonly accountId: string;

  constructor(baseUrl: string, accountId: string) {
    this.baseUrl   = baseUrl;
    this.accountId = accountId;
  }

  async createOrder(order: OrderPlan, clOrdID: string): Promise<Order> {
    const body: Record<string, unknown> = {
      symbol:   order.symbol,
      side:     order.side,
      ordType:  order.ordType,
      clOrdID,
    };

    if (order.orderQty       !== undefined) body['orderQty']       = order.orderQty;
    if (order.price          !== undefined) body['price']          = order.price;
    if (order.stopPx         !== undefined) body['stopPx']         = order.stopPx;
    if (order.pegOffsetValue !== undefined) body['pegOffsetValue'] = order.pegOffsetValue;
    if (order.pegPriceType   !== undefined) body['pegPriceType']   = order.pegPriceType;
    if (order.timeInForce    !== undefined) body['timeInForce']    = order.timeInForce;
    if (order.execInst       !== undefined) body['execInst']       = order.execInst;
    if (order.displayQty     !== undefined) body['displayQty']     = order.displayQty;

    const res = await this.request('POST', '/order', body);

    return res as Order;
  }

  async amendOrder(
    orderID: string,
    amend:   { price?: number; leavesQty?: number },
  ): Promise<Order | null> {
    const body: Record<string, unknown> = { orderID };

    if (amend.price     !== undefined) body['price']     = amend.price;
    if (amend.leavesQty !== undefined) body['leavesQty'] = amend.leavesQty;

    const url     = `${this.baseUrl}/api/v1/order`;
    const bodyStr = JSON.stringify(body);
    let   res: Response;

    try {
      res = await this.fetchWithRateLimit('PUT', url, bodyStr);
    } catch (err) {
      logger.error({ err, orderID }, 'Amend order — network error');
      return null;
    }

    if (res.status === 404) return null;

    if (! res.ok) {
      const text = await res.text().catch(() => '');

      if (res.status === 400 && text.includes('Not Found')) return null;

      logger.error({ status: res.status, body: text, orderID }, 'Amend order — REST error');
      return null;
    }

    return res.json() as Promise<Order>;
  }

  async cancelOrders(orderIDs: string[]): Promise<void> {
    if (orderIDs.length === 0) return;

    // BitMEX bulk cancel: orderID field contains JSON-encoded array of IDs
    await this.request('DELETE', '/order', {
      orderID: orderIDs.length === 1 ? orderIDs[0] : JSON.stringify(orderIDs),
    });
  }

  async getOrders(symbol: string): Promise<Order[]> {
    const filter = encodeURIComponent(JSON.stringify({ symbol }));
    const url    = `${this.baseUrl}/api/v1/order?filter=${filter}&count=500`;

    try {
      const res = await fetch(url, { headers: this.headers() });

      if (! res.ok) {
        logger.warn({ status: res.status, symbol }, 'getOrders failed — starting with empty managed list');
        return [];
      }

      return res.json() as Promise<Order[]>;
    } catch (err) {
      logger.warn({ err, symbol }, 'getOrders network error — starting with empty managed list');
      return [];
    }
  }

  // ---- Private -----------------------------------------------------------

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'x-account-id': this.accountId,
    };
  }

  private async request(
    verb:    'POST' | 'PUT' | 'DELETE',
    path:    string,
    body:    Record<string, unknown>,
    attempt = 1,
  ): Promise<unknown> {
    const url     = `${this.baseUrl}/api/v1${path}`;
    const bodyStr = JSON.stringify(body);
    let   res: Response;

    try {
      res = await this.fetchWithRateLimit(verb, url, bodyStr);
    } catch (err) {
      if (attempt <= MAX_RETRIES) {
        await sleep(RETRY_BASE_MS * attempt);
        return this.request(verb, path, body, attempt + 1);
      }

      logger.error({ err, verb, path }, 'REST request failed after retries');
      throw err;
    }

    if (res.status === 429) {
      const waitMs = resetWaitMs(res);
      await sleep(waitMs);
      return this.request(verb, path, body, attempt + 1);
    }

    if (res.status >= 500 && attempt <= MAX_RETRIES) {
      await sleep(RETRY_BASE_MS * attempt);
      return this.request(verb, path, body, attempt + 1);
    }

    if (! res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`REST ${verb} ${path} failed (${res.status}): ${text}`);
    }

    return res.json().catch(() => null);
  }

  private async fetchWithRateLimit(
    verb:    string,
    url:     string,
    bodyStr: string,
  ): Promise<Response> {
    const res = await fetch(url, {
      method:  verb,
      headers: this.headers(),
      body:    bodyStr,
    });

    const remaining = parseInt(res.headers.get('x-ratelimit-remaining') ?? '999', 10);

    if (remaining < RATE_LIMIT_BUFFER) {
      const waitMs = resetWaitMs(res);
      logger.warn({ remaining, waitMs }, 'Rate limit low — pausing');
      await sleep(waitMs);
    }

    return res;
  }
}

function resetWaitMs(res: Response): number {
  const reset = parseInt(res.headers.get('x-ratelimit-reset') ?? '0', 10);
  return Math.max(0, reset * 1000 - Date.now()) + 100;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
