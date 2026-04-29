/**
 * Boundary: Express routes for the private REST API surface.
 *
 * No business logic lives here — only request parsing, account resolution,
 * delegation to the appropriate pure core function, and JSON serialisation.
 *
 * Account is identified from the 'api-key' request header. Teller trusts it at
 * face value — authentication is the responsibility of the rest proxy in front.
 * Accounts are created on first use (lazy initialisation).
 */
import express, { type Request, type Response, type NextFunction } from 'express';
import { logger } from '@devvir/service-kit';
import { getState, getConfig, getMongo } from '../store';
import * as accounts from '../accounts';
import * as orders from '../orders';
import * as marginModule from '../margin';
import * as db from '../db';
import * as publisher from '../publisher';
import { computeGuard } from '../fills/engine';
import { executeMarketFill } from '../fills/execute';
import { TellerError } from '../types';
import type { AmendFields } from '../types';

export function buildRouter(): express.Router {
  const router = express.Router();
  router.use(express.json());

  // ── Account middleware ───────────────────────────────────────────────────────

  const requireAccount = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const accountId = req.headers['api-key'] as string | undefined;

    if (! accountId) {
      res.status(401).json({ error: { message: 'api-key header required', name: 'HTTPError' } });
      return;
    }

    (req as any).accountId = accountId;

    const state = getState();

    if (! state.store.has(accountId)) {
      const config          = getConfig();
      const now             = new Date().toISOString();
      const newAccountState = accounts.initAccount(accountId, config.initialBalance.amount, now);

      state.store.set(accountId, newAccountState);
      await db.margin.upsert(newAccountState.margin);
    }

    next();
  };

  const wrap = (fn: (req: Request, res: Response) => Promise<void>) =>
    async (req: Request, res: Response) => {
      try {
        await fn(req, res);
      } catch (err) {
        if (err instanceof TellerError) {
          res.status(err.statusCode).json({ error: { message: err.message, name: 'HTTPError' } });
        } else {
          logger.error({ err }, 'REST: unhandled error');
          res.status(500).json({ error: { message: 'Internal server error', name: 'HTTPError' } });
        }
      }
    };

  // ── Orders ───────────────────────────────────────────────────────────────────

  router.get('/api/v1/order', requireAccount, wrap(async (req, res) => {
    const accountId = (req as any).accountId as string;
    const { symbol } = req.query;
    const state      = getState();
    const account    = state.store.get(accountId)!;
    let   orderList  = [...account.orders.values()];

    if (symbol) orderList = orderList.filter(o => o.symbol === symbol);

    res.json(orderList);
  }));

  router.post('/api/v1/order', requireAccount, wrap(async (req, res) => {
    const accountId = (req as any).accountId as string;
    const state     = getState();
    const account   = state.store.get(accountId)!;
    const now       = new Date().toISOString();

    const { state: newState, order } = orders.createOrder(account, {
      ...req.body,
      timestamp: now,
    });

    state.store.set(accountId, newState);

    if (order.ordType === 'Market') {
      // Market orders fill immediately at the last known mark price
      await executeMarketFill(order, now);
      const filled = state.store.get(accountId)?.orders.get(order.orderID);
      res.status(200).json(filled ?? order);
      return;
    }

    // Limit order: debit initial margin, write to DB, publish WS events
    const instrument = state.instruments.get(order.symbol);

    if (instrument) {
      const updatedMargin = marginModule.applyOrderMargin(
        newState.margin, order.orderQty, order.price!, instrument.initMarginReq, 'debit',
      );
      newState.margin = updatedMargin;
      await db.margin.upsert(updatedMargin);
      await publisher.publishMarkPriceUpdate(accountId, [...newState.positions.values()], updatedMargin, now);
    }

    // Update price guard
    const allSymbolOrders = [...state.store.values()].flatMap(s => [...s.orders.values()]).filter(o => o.symbol === order.symbol);
    state.guards.set(order.symbol, computeGuard(allSymbolOrders));

    await db.order.upsert(order);
    await publisher.publishPartial(accountId, 'order', [order], now);

    res.status(200).json(order);
  }));

  router.put('/api/v1/order', requireAccount, wrap(async (req, res) => {
    const accountId = (req as any).accountId as string;
    const state     = getState();
    const account   = state.store.get(accountId)!;
    const orderId   = req.body.orderID as string;

    if (! orderId) throw new TellerError('orderID is required');

    const fields: AmendFields = {};
    if (req.body.price    !== undefined) fields.price    = Number(req.body.price);
    if (req.body.orderQty !== undefined) fields.orderQty = Number(req.body.orderQty);

    const { state: newState, order } = orders.amendOrder(account, orderId, fields);
    state.store.set(accountId, newState);

    const allSymbolOrders = [...state.store.values()].flatMap(s => [...s.orders.values()]).filter(o => o.symbol === order.symbol);
    state.guards.set(order.symbol, computeGuard(allSymbolOrders));

    const now = new Date().toISOString();
    await db.order.upsert(order);
    await publisher.publishPartial(accountId, 'order', [order], now);

    res.json(order);
  }));

  router.delete('/api/v1/order', requireAccount, wrap(async (req, res) => {
    const accountId = (req as any).accountId as string;
    const state     = getState();
    const account   = state.store.get(accountId)!;
    const orderId   = (req.query.orderID ?? req.body?.orderID) as string;

    if (! orderId) throw new TellerError('orderID is required');

    const { state: newState, order } = orders.cancelOrder(account, orderId, 'Canceled by user');
    state.store.set(accountId, newState);

    const allSymbolOrders = [...state.store.values()].flatMap(s => [...s.orders.values()]).filter(o => o.symbol === order.symbol);
    state.guards.set(order.symbol, computeGuard(allSymbolOrders));

    const now = new Date().toISOString();
    await db.order.upsert(order);
    await publisher.publishPartial(accountId, 'order', [order], now);

    res.json([order]);
  }));

  router.delete('/api/v1/order/all', requireAccount, wrap(async (req, res) => {
    const accountId = (req as any).accountId as string;
    const symbol    = req.query.symbol as string | undefined;
    const state     = getState();
    const account   = state.store.get(accountId)!;

    const { state: newState, orders: canceled } = orders.cancelAllOrders(account, symbol);
    state.store.set(accountId, newState);

    if (symbol) {
      const allSymbolOrders = [...state.store.values()].flatMap(s => [...s.orders.values()]).filter(o => o.symbol === symbol);
      state.guards.set(symbol, computeGuard(allSymbolOrders));
    }

    const now = new Date().toISOString();
    await Promise.all(canceled.map(o => db.order.upsert(o)));
    if (canceled.length > 0) await publisher.publishPartial(accountId, 'order', canceled, now);

    res.json(canceled);
  }));

  // ── Position / margin / wallet ───────────────────────────────────────────────

  router.get('/api/v1/position', requireAccount, (req, res) => {
    const accountId = (req as any).accountId as string;
    const account   = getState().store.get(accountId)!;
    res.json([...account.positions.values()]);
  });

  router.get('/api/v1/user/margin', requireAccount, (req, res) => {
    const accountId = (req as any).accountId as string;
    res.json(getState().store.get(accountId)!.margin);
  });

  router.get('/api/v1/user/wallet', requireAccount, (req, res) => {
    const accountId = (req as any).accountId as string;
    const m = getState().store.get(accountId)!.margin;
    res.json({ amount: m.walletBalance, currency: m.currency });
  });

  router.get('/api/v1/execution', requireAccount, wrap(async (req, res) => {
    const accountId = (req as any).accountId as string;
    const limit     = Number(req.query.count ?? 100);
    const reverse   = req.query.reverse !== 'false';
    const history   = await db.execution.findByAccount(accountId, limit, reverse);
    res.json(history);
  }));

  // ── Deposit / withdrawal ─────────────────────────────────────────────────────

  router.post('/api/v1/user/deposit', requireAccount, wrap(async (req, res) => {
    const accountId = (req as any).accountId as string;
    const state     = getState();
    const account   = state.store.get(accountId)!;
    const amount    = Number(req.body?.amount);

    if (! Number.isFinite(amount)) throw new TellerError('amount must be a finite number');

    const newMargin = marginModule.applyDeposit(account.margin, amount);
    account.margin = newMargin;

    // Recompute liquidation price for all open positions (balance change affects liquidation)
    const instrument = state.instruments;
    const updatedPositions: import('../types').PositionDoc[] = [];

    for (const [sym, pos] of account.positions) {
      const instr = instrument.get(sym);
      if (instr) {
        const updated = marginModule.recomputeLiquidation(pos, newMargin, instr);
        account.positions.set(sym, updated);
        updatedPositions.push(updated);
      }
    }

    const now = new Date().toISOString();
    await db.margin.upsert(newMargin);
    await Promise.all(updatedPositions.map(p => db.position.upsert(p)));
    await publisher.publishMarkPriceUpdate(accountId, updatedPositions, newMargin, now);

    res.json(newMargin);
  }));

  // ── Internal control endpoints ───────────────────────────────────────────────

  /** Called by ws when a bot subscribes to a private table. */
  router.post('/subscribed/:accountId/:table', wrap(async (req, res) => {
    const accountId = req.params['accountId'] as string;
    const table     = req.params['table'] as string;
    const KNOWN_TABLES = ['order', 'execution', 'position', 'margin'];

    if (! KNOWN_TABLES.includes(table)) {
      res.status(400).json({ error: { message: `Unknown table: ${table}`, name: 'HTTPError' } });
      return;
    }

    const state   = getState();
    const account = state.store.get(accountId);
    const now     = new Date().toISOString();

    let data: unknown[] = [];

    if (account) {
      if (table === 'order')     data = [...account.orders.values()];
      if (table === 'position')  data = [...account.positions.values()];
      if (table === 'margin')    data = [account.margin];
      if (table === 'execution') data = await db.execution.findByAccount(accountId, 100);
    }

    await publisher.publishPartial(accountId, table, data, now);

    res.status(201).json({ ok: true });
  }));

  /** Wipe all state for an account — for orchestrator use between training runs. */
  router.post('/reset/:accountId', wrap(async (req, res) => {
    const accountId = req.params['accountId'] as string;
    const { store }     = getState();
    const { database }  = getConfig();
    const mdb           = getMongo().db(database);

    store.delete(accountId);

    await Promise.all([
      mdb.collection('order').deleteMany({ accountId }),
      mdb.collection('execution').deleteMany({ accountId }),
      mdb.collection('position').deleteMany({ accountId }),
      mdb.collection('margin').deleteMany({ accountId }),
    ]);

    res.json({ ok: true });
  }));

  return router;
}
