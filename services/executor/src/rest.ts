import { logger } from '@devvir/service-kit';
import type { Config, DesiredOrder, AmendOp, CancelOp } from './types';
import type { AccountRegistry } from './accounts';

const MAX_RETRIES       = 3;
const RETRY_BASE_MS     = 500;
const RATE_LIMIT_BUFFER = 10;

export interface RestClient {
  createOrder:  (accountId: string, order: DesiredOrder & { symbol: string }, clOrdID: string) => Promise<unknown>;
  amendOrder:   (accountId: string, op: AmendOp) => Promise<{ stale?: boolean } | unknown>;
  cancelOrders: (accountId: string, ops: CancelOp[]) => Promise<unknown>;
}

export function createRestClient(accounts: AccountRegistry, config: Config): RestClient {
  async function sign(accountId: string, verb: string, path: string, body: string): Promise<{ apiKey: string; expires: number; signature: string }> {
    const expires = Math.round(Date.now() / 1000) + 5;
    const res = await fetch(`${config.bouncerUrl}/sign/rest`, {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${config.bouncerToken}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ accountId, verb, path, expires, body }),
    });

    if (! res.ok) throw new Error(`Bouncer sign/rest failed: ${res.status}`);

    return res.json() as Promise<{ apiKey: string; expires: number; signature: string }>;
  }

  async function request(accountId: string, verb: 'POST' | 'PUT' | 'DELETE', path: string, body: Record<string, unknown>, attempt = 1): Promise<unknown> {
    const account = await accounts.get(accountId);
    const fullUrl = account.restUrl + path;
    const urlPath = new URL(fullUrl).pathname;
    const bodyStr = JSON.stringify(body);

    let auth: { apiKey: string; expires: number; signature: string };

    try {
      auth = await sign(accountId, verb, urlPath, bodyStr);
    } catch (err) {
      logger.error({ err, verb, path }, 'Failed to get signature from bouncer');
      return null;
    }

    let res: Response;

    try {
      res = await fetch(fullUrl, {
        method:  verb,
        headers: {
          'Content-Type':  'application/json',
          'api-key':       auth.apiKey,
          'api-expires':   String(auth.expires),
          'api-signature': auth.signature,
        },
        body: bodyStr,
      });
    } catch (err) {
      if (attempt <= MAX_RETRIES) {
        await sleep(RETRY_BASE_MS * attempt);
        return request(accountId, verb, path, body, attempt + 1);
      }

      logger.error({ err, verb, path }, 'REST request failed after retries');
      return null;
    }

    const remaining = parseInt(res.headers.get('x-ratelimit-remaining') ?? '999', 10);

    if (remaining < RATE_LIMIT_BUFFER) {
      const reset  = parseInt(res.headers.get('x-ratelimit-reset') ?? '0', 10);
      const waitMs = Math.max(0, reset * 1000 - Date.now()) + 100;
      logger.warn({ remaining, waitMs }, 'Rate limit low — pausing');
      await sleep(waitMs);
    }

    if (res.status === 429) {
      const reset  = parseInt(res.headers.get('x-ratelimit-reset') ?? '0', 10);
      const waitMs = Math.max(0, reset * 1000 - Date.now()) + 100;
      await sleep(waitMs);
      return request(accountId, verb, path, body, attempt + 1);
    }

    if (res.status >= 500 && attempt <= MAX_RETRIES) {
      await sleep(RETRY_BASE_MS * attempt);
      return request(accountId, verb, path, body, attempt + 1);
    }

    if (! res.ok) {
      logger.error({ status: res.status, body: await res.text().catch(() => ''), verb, path }, 'REST error');
      return null;
    }

    return res.json().catch(() => null);
  }

  async function createOrder(accountId: string, order: DesiredOrder & { symbol: string }, clOrdID: string): Promise<unknown> {
    const body: Record<string, unknown> = { symbol: order.symbol, side: order.side, ordType: order.ordType, clOrdID };

    if (order.orderQty       !== undefined) body['orderQty']       = order.orderQty;
    if (order.price          !== undefined) body['price']          = order.price;
    if (order.stopPx         !== undefined) body['stopPx']         = order.stopPx;
    if (order.pegOffsetValue !== undefined) body['pegOffsetValue'] = order.pegOffsetValue;
    if (order.pegPriceType   !== undefined) body['pegPriceType']   = order.pegPriceType;
    if (order.timeInForce    !== undefined) body['timeInForce']    = order.timeInForce;
    if (order.execInst       !== undefined) body['execInst']       = order.execInst;
    if (order.displayQty     !== undefined) body['displayQty']     = order.displayQty;

    return request(accountId, 'POST', '/order', body);
  }

  async function amendOrder(accountId: string, op: AmendOp): Promise<{ stale?: boolean } | unknown> {
    const account = await accounts.get(accountId);
    const fullUrl = account.restUrl + '/order';
    const urlPath = new URL(fullUrl).pathname;
    const body: Record<string, unknown> = { orderID: op.orderID };

    if (op.price     !== undefined) body['price']     = op.price;
    if (op.leavesQty !== undefined) body['leavesQty'] = op.leavesQty;

    const bodyStr = JSON.stringify(body);

    let auth: { apiKey: string; expires: number; signature: string };

    try {
      auth = await sign(accountId, 'PUT', urlPath, bodyStr);
    } catch (err) {
      logger.error({ err, op }, 'Failed to get signature for amend');
      return null;
    }

    let res: Response;

    try {
      res = await fetch(fullUrl, {
        method:  'PUT',
        headers: {
          'Content-Type':  'application/json',
          'api-key':       auth.apiKey,
          'api-expires':   String(auth.expires),
          'api-signature': auth.signature,
        },
        body: bodyStr,
      });
    } catch (err) {
      logger.error({ err, op }, 'REST PUT /order — network error');
      return null;
    }

    if (res.status === 404) return { stale: true };

    if (! res.ok) {
      const text = await res.text().catch(() => '');

      if (res.status === 400 && text.includes('Not Found')) return { stale: true };

      logger.error({ status: res.status, body: text, op }, 'REST PUT /order error');
      return null;
    }

    return res.json().catch(() => null);
  }

  async function cancelOrders(accountId: string, ops: CancelOp[]): Promise<unknown> {
    if (ops.length === 0) return null;

    return request(accountId, 'DELETE', '/order', { orderID: JSON.stringify(ops.map((o) => o.orderID)) });
  }

  return { createOrder, amendOrder, cancelOrders };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
