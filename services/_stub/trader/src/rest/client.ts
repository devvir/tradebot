/**
 * HTTP REST client for the exchange REST API.
 *
 * Single client; same code path against both:
 *   - our `rest` service  (proxy detects pre-signed requests and forwards verbatim)
 *   - BitMEX directly     (BitMEX validates the signature)
 *
 * Behaviour:
 *   - BitMEX-compatible HMAC signing per request (api-key / api-expires / api-signature)
 *   - Rate-limit awareness via x-ratelimit-remaining header
 *   - Linear-backoff retry for network failures and 5xx responses
 *   - Stale amend detection (returns null on 404 or 400 "Not Found")
 *   - Batch cancel (single `orderID` for one, JSON-encoded array for many)
 */

import { logger } from '@devvir/service-kit';
import { signRestHeaders } from '../auth';
import type { ApiCredentials, HttpVerb } from '../auth';
import type { Order } from '../types';
import type { OrderPlan } from '../planner/types';
import type { AmendArgs, RestClient } from './types';

const API_BASE          = '/api/v1';
const MAX_RETRIES       = 3;
const RETRY_BASE_MS     = 500;
const RATE_LIMIT_BUFFER = 10;
const GET_ORDERS_LIMIT  = 500;

export class HttpRestClient implements RestClient {
  private readonly baseUrl: string;
  private readonly creds:   ApiCredentials;

  constructor(baseUrl: string, creds: ApiCredentials) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.creds   = creds;
  }

  async createOrder(order: OrderPlan, clOrdID: string): Promise<Order> {
    const body = buildCreateBody(order, clOrdID);
    const res  = await this.requestJson('POST', '/order', body);

    return res as Order;
  }

  async amendOrder(orderID: string, amend: AmendArgs): Promise<Order | null> {
    const body = buildAmendBody(orderID, amend);

    return this.requestStaleAware('PUT', '/order', body);
  }

  async cancelOrders(orderIDs: string[]): Promise<void> {
    if (orderIDs.length === 0) return;

    // BitMEX bulk cancel: a single ID is a string; multiple IDs are a JSON-encoded array.
    const orderID = orderIDs.length === 1 ? orderIDs[0]! : JSON.stringify(orderIDs);

    await this.requestJson('DELETE', '/order', { orderID });
  }

  async getOrders(symbol: string): Promise<Order[]> {
    const filter = encodeURIComponent(JSON.stringify({ symbol }));
    const path   = `/order?filter=${filter}&count=${GET_ORDERS_LIMIT}`;

    try {
      const res = await this.requestJson('GET', path, null);

      return (res as Order[] | null) ?? [];
    } catch (err) {
      logger.warn({ err, symbol }, 'getOrders failed — starting with empty managed list');
      return [];
    }
  }

  // ---- Private -----------------------------------------------------------

  /** Verb-aware request that handles stale (404 / "Not Found") as null. */
  private async requestStaleAware(
    verb: HttpVerb,
    path: string,
    body: Record<string, unknown>,
  ): Promise<Order | null> {
    const fullPath = `${API_BASE}${path}`;
    const bodyStr  = JSON.stringify(body);

    let res: Response;

    try {
      res = await this.fetchSigned(verb, fullPath, bodyStr);
    } catch (err) {
      logger.error({ err, verb, path }, 'REST request — network error');
      return null;
    }

    if (res.status === 404) return null;

    if (! res.ok) {
      const text = await res.text().catch(() => '');

      if (res.status === 400 && text.includes('Not Found')) return null;

      logger.error({ status: res.status, body: text, verb, path }, 'REST request failed');
      return null;
    }

    return res.json() as Promise<Order>;
  }

  /** General request with retry/backoff. body is JSON-stringified; pass null for no body. */
  private async requestJson(
    verb:    HttpVerb,
    path:    string,
    body:    Record<string, unknown> | null,
    attempt = 1,
  ): Promise<unknown> {
    const fullPath = `${API_BASE}${path}`;
    const bodyStr  = body === null ? '' : JSON.stringify(body);

    let res: Response;

    try {
      res = await this.fetchSigned(verb, fullPath, bodyStr);
    } catch (err) {
      if (attempt <= MAX_RETRIES) {
        await sleep(RETRY_BASE_MS * attempt);
        return this.requestJson(verb, path, body, attempt + 1);
      }

      logger.error({ err, verb, path }, 'REST request failed after retries');
      throw err;
    }

    if (res.status === 429) {
      await sleep(resetWaitMs(res));
      return this.requestJson(verb, path, body, attempt + 1);
    }

    if (res.status >= 500 && attempt <= MAX_RETRIES) {
      await sleep(RETRY_BASE_MS * attempt);
      return this.requestJson(verb, path, body, attempt + 1);
    }

    if (! res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`REST ${verb} ${path} failed (${res.status}): ${text}`);
    }

    return res.json().catch(() => null);
  }

  /** Sign + send + back off if rate-limit headroom is low. */
  private async fetchSigned(verb: HttpVerb, fullPath: string, bodyStr: string): Promise<Response> {
    const url     = `${this.baseUrl}${fullPath}`;
    const auth    = signRestHeaders(this.creds, verb, fullPath, bodyStr);
    const headers = {
      ...auth,
      'Content-Type': 'application/json',
      'Accept':       'application/json',
    };

    const init: RequestInit = { method: verb, headers };

    if (verb !== 'GET' && bodyStr.length > 0) init.body = bodyStr;

    const res = await fetch(url, init);

    const remaining = parseInt(res.headers.get('x-ratelimit-remaining') ?? '999', 10);

    if (remaining < RATE_LIMIT_BUFFER) {
      const waitMs = resetWaitMs(res);
      logger.warn({ remaining, waitMs }, 'Rate limit low — pausing');
      await sleep(waitMs);
    }

    return res;
  }
}

// ---- Body builders ------------------------------------------------------

function buildCreateBody(order: OrderPlan, clOrdID: string): Record<string, unknown> {
  const body: Record<string, unknown> = {
    symbol:  order.symbol,
    side:    order.side,
    ordType: order.ordType,
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

  return body;
}

function buildAmendBody(orderID: string, amend: AmendArgs): Record<string, unknown> {
  const body: Record<string, unknown> = { orderID };

  if (amend.price     !== undefined) body['price']     = amend.price;
  if (amend.leavesQty !== undefined) body['leavesQty'] = amend.leavesQty;

  return body;
}

// ---- Helpers ------------------------------------------------------------

function resetWaitMs(res: Response): number {
  const reset = parseInt(res.headers.get('x-ratelimit-reset') ?? '0', 10);

  return Math.max(0, reset * 1000 - Date.now()) + 100;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
