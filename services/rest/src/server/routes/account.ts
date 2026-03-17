import { type Application, type Request, type Response } from 'express';
import { logger, type Service } from '@devvir/service-kit';
import { z } from 'zod';
import { validateQuery } from '../middleware';
import mocks from '../mocks.json';
import {
  PositionGetQueryParams,
  UserGetMarginQueryParams,
  ExecutionGetQueryParams,
  ExecutionGetTradeHistoryQueryParams,
  FundingGetQueryParams,
  UserEventGetQueryParams,
  UserGetWalletQueryParams,
  UserGetWalletHistoryQueryParams,
  UserGetWalletSummaryQueryParams,
  UserGetDepositAddressQueryParams,
} from '../../types';

/**
 * Setup account routes
 *
 * Authenticated endpoints for user account data:
 * - GET endpoints return account state (positions, margin, execution history, etc.)
 * - Will consume deltas from account exchange when implemented
 *
 * Currently returns mocked responses.
 * Authentication is not yet implemented.
 */
export const setupAccountRoutes = (app: Application, _service: Service): void => {
  // ── API Key ────────────────────────────────────────────────────────

  app.get('/apiKey', (_: Request, res: Response) => {
    logger.debug('GET /apiKey (not yet implemented)');
    return res.json([]);
  });

  // ── Position ───────────────────────────────────────────────────────

  app.get('/position', validateQuery(PositionGetQueryParams), (_req: Request, res: Response) => {
    logger.debug({ query: res.locals.query }, 'GET /position (not yet implemented)');
    return res.json(mocks.position);
  });

  app.get('/position/isolate', (_: Request, res: Response) => {
    logger.debug('GET /position/isolate (not yet implemented)');
    return res.status(200).json({});
  });

  app.post('/position/isolate', (req: Request, res: Response) => {
    logger.debug({ body: req.body }, 'POST /position/isolate (not yet implemented)');
    return res.json({});
  });

  app.get('/position/riskLimit', (_: Request, res: Response) => {
    logger.debug('GET /position/riskLimit (not yet implemented)');
    return res.json([]);
  });

  app.post('/position/riskLimit', (req: Request, res: Response) => {
    logger.debug({ body: req.body }, 'POST /position/riskLimit (not yet implemented)');
    return res.json({});
  });

  app.post('/position/transferMargin', (req: Request, res: Response) => {
    logger.debug({ body: req.body }, 'POST /position/transferMargin (not yet implemented)');
    return res.json({});
  });

  app.get('/position/leverage', (_: Request, res: Response) => {
    logger.debug('GET /position/leverage (not yet implemented)');
    return res.json({});
  });

  app.post('/position/leverage', (req: Request, res: Response) => {
    logger.debug({ body: req.body }, 'POST /position/leverage (not yet implemented)');
    return res.json({});
  });

  app.get('/position/crossLeverage', (_: Request, res: Response) => {
    logger.debug('GET /position/crossLeverage (not yet implemented)');
    return res.json({});
  });

  app.post('/position/crossLeverage', (req: Request, res: Response) => {
    logger.debug({ body: req.body }, 'POST /position/crossLeverage (not yet implemented)');
    return res.json({});
  });

  // ── Margin ─────────────────────────────────────────────────────────

  app.get('/user/margin', validateQuery(UserGetMarginQueryParams), (_req: Request, res: Response) => {
    logger.debug({ query: res.locals.query }, 'GET /user/margin (not yet implemented)');
    return res.json(mocks.margin);
  });

  // ── Execution ──────────────────────────────────────────────────────

  app.get('/execution', validateQuery(ExecutionGetQueryParams), (_req: Request, res: Response) => {
    logger.debug({ query: res.locals.query }, 'GET /execution (not yet implemented)');
    return res.json(mocks.execution);
  });

  app.get('/execution/tradeHistory', validateQuery(ExecutionGetTradeHistoryQueryParams), (_req: Request, res: Response) => {
    logger.debug({ query: res.locals.query }, 'GET /execution/tradeHistory (not yet implemented)');
    return res.json(mocks.execution);
  });

  // ── Funding ────────────────────────────────────────────────────────

  app.get('/funding', validateQuery(FundingGetQueryParams), (_req: Request, res: Response) => {
    logger.debug({ query: res.locals.query }, 'GET /funding (not yet implemented)');
    return res.json([]);
  });

  // ── User ───────────────────────────────────────────────────────────

  app.get('/user', (_: Request, res: Response) => {
    logger.debug('GET /user (not yet implemented)');
    return res.json({});
  });

  app.get('/userEvent', validateQuery(UserEventGetQueryParams), (_req: Request, res: Response) => {
    logger.debug({ query: res.locals.query }, 'GET /userEvent (not yet implemented)');
    return res.json([]);
  });

  // ── Wallet ─────────────────────────────────────────────────────────

  app.get('/user/wallet', validateQuery(UserGetWalletQueryParams), (_req: Request, res: Response) => {
    logger.debug({ query: res.locals.query }, 'GET /user/wallet (not yet implemented)');
    return res.json(mocks.wallet);
  });

  app.get('/user/walletHistory', validateQuery(UserGetWalletHistoryQueryParams), (_req: Request, res: Response) => {
    logger.debug({ query: res.locals.query }, 'GET /user/walletHistory (not yet implemented)');
    return res.json([]);
  });

  app.get('/user/walletSummary', validateQuery(UserGetWalletSummaryQueryParams), (_req: Request, res: Response) => {
    logger.debug({ query: res.locals.query }, 'GET /user/walletSummary (not yet implemented)');
    return res.json([]);
  });

  // ── Deposit ────────────────────────────────────────────────────────

  app.get('/user/depositAddress', validateQuery(UserGetDepositAddressQueryParams), (_req: Request, res: Response) => {
    logger.debug({ query: res.locals.query }, 'GET /user/depositAddress (not yet implemented)');
    return res.json('');
  });

  app.post('/user/requestWithdrawal', (req: Request, res: Response) => {
    logger.debug({ body: req.body }, 'POST /user/requestWithdrawal (not yet implemented)');
    return res.json({});
  });

  app.get(
    '/user/withdrawal',
    validateQuery(
      z.object({
        currency: z.string().optional(),
        status: z.string().optional(),
        count: z.number().optional(),
        start: z.number().optional(),
      }),
    ),
    (_req: Request, res: Response) => {
      logger.debug({ query: res.locals.query }, 'GET /user/withdrawal (not yet implemented)');
      return res.json([]);
    },
  );

  app.post('/user/cancelWithdrawal', (req: Request, res: Response) => {
    logger.debug({ body: req.body }, 'POST /user/cancelWithdrawal (not yet implemented)');
    return res.json({});
  });

  // ── Preferences ────────────────────────────────────────────────────

  app.get('/user/preferences', (_: Request, res: Response) => {
    logger.debug('GET /user/preferences (not yet implemented)');
    return res.json({});
  });

  app.post('/user/preferences', (req: Request, res: Response) => {
    logger.debug({ body: req.body }, 'POST /user/preferences (not yet implemented)');
    return res.json({});
  });

  // ── Other account endpoints ────────────────────────────────────────

  app.get('/user/commission', (_: Request, res: Response) => {
    logger.debug('GET /user/commission (not yet implemented)');
    return res.json({});
  });

  app.post('/user/logout', (_: Request, res: Response) => {
    logger.debug('POST /user/logout (not yet implemented)');
    return res.json({});
  });
};
