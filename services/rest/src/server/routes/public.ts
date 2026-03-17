import { type Application, type Request, type Response } from 'express';
import { logger, type Service } from '@devvir/service-kit';
import { OrderBookQuerySchema, TradeQuerySchema, QuoteQuerySchema, InstrumentQuerySchema, SettlementGetQueryParams } from '../../types';
import { fetchSnapshot, filterSnapshotData } from '../../snapshots';
import { validateQuery } from '../middleware';

/**
 * Setup public (market data) routes
 *
 * GET endpoints that return latest snapshots from the snapshots service.
 * - No authentication required
 * - Data is fresh from snapshots service on each request
 * - Fetches from snapshots HTTP server and transforms to BitMEX format
 */
export const setupPublicRoutes = (app: Application, service: Service): void => {
  const snapshotsUrl = service.config('snapshotsUrl') as string;
  // ── Announcements ──────────────────────────────────────────────────

  app.get('/announcement', (_req: Request, res: Response) => {
    logger.debug('GET /announcement');
    return res.json([]);
  });

  app.get('/announcement/urgent', (_req: Request, res: Response) => {
    logger.debug('GET /announcement/urgent');
    return res.json([]);
  });

  // ── Chat ───────────────────────────────────────────────────────────

  app.get('/chat/pinned', (_req: Request, res: Response) => {
    logger.debug('GET /chat/pinned');
    return res.json({ id: 1, message: '' });
  });

  app.get('/chat', (_req: Request, res: Response) => {
    logger.debug('GET /chat');
    return res.json([]);
  });

  app.get('/chat/channels', (_req: Request, res: Response) => {
    logger.debug('GET /chat/channels');
    return res.json([]);
  });

  app.get('/chat/connected', (_req: Request, res: Response) => {
    logger.debug('GET /chat/connected');
    return res.json([[], []]);
  });

  // ── Insurance ──────────────────────────────────────────────────────

  app.get('/insurance', (_req: Request, res: Response) => {
    logger.debug('GET /insurance');
    return res.json([]);
  });

  // ── Leaderboard ────────────────────────────────────────────────────

  app.get('/leaderboard', (_req: Request, res: Response) => {
    logger.debug('GET /leaderboard');
    return res.json([]);
  });

  app.get('/leaderboard/name', (_req: Request, res: Response) => {
    logger.debug('GET /leaderboard/name');
    return res.json([]);
  });

  // ── Order Book ─────────────────────────────────────────────────────

  app.get('/orderBook/L2', validateQuery(OrderBookQuerySchema), async (_req: Request, res: Response) => {
    logger.debug({ query: res.locals.query }, 'GET /orderBook/L2');
    const data = await fetchSnapshot(snapshotsUrl, 'orderBookL2');
    const filtered = filterSnapshotData(data, res.locals.query);
    return res.json(filtered);
  });

  app.get('/orderBook/L2_25', validateQuery(OrderBookQuerySchema), async (_req: Request, res: Response) => {
    logger.debug({ query: res.locals.query }, 'GET /orderBook/L2_25');
    // L2_25 is the same table as L2, just filtered to 25 levels by BitMEX
    const data = await fetchSnapshot(snapshotsUrl, 'orderBookL2');
    const filtered = filterSnapshotData(data, res.locals.query);
    return res.json(filtered.slice(0, 25));
  });

  // ── Quote ──────────────────────────────────────────────────────────

  app.get('/quote', validateQuery(QuoteQuerySchema), async (_req: Request, res: Response) => {
    logger.debug({ query: res.locals.query }, 'GET /quote');
    const data = await fetchSnapshot(snapshotsUrl, 'quote');
    const filtered = filterSnapshotData(data, res.locals.query);
    return res.json(filtered);
  });

  app.get('/quote/bucketed', validateQuery(QuoteQuerySchema), async (_req: Request, res: Response) => {
    logger.debug({ query: res.locals.query }, 'GET /quote/bucketed');
    // Use 1m binned quotes (most common bucketed interval)
    const data = await fetchSnapshot(snapshotsUrl, 'quoteBin1m');
    const filtered = filterSnapshotData(data, res.locals.query);
    return res.json(filtered);
  });

  // ── Schema ─────────────────────────────────────────────────────────

  app.get('/schema', (_: Request, res: Response) => {
    logger.debug('GET /schema');
    return res.json([]);
  });

  app.get('/schema/websocketHelp', (_: Request, res: Response) => {
    logger.debug('GET /schema/websocketHelp');
    return res.json({});
  });

  // ── Settlement ─────────────────────────────────────────────────────

  app.get('/settlement', validateQuery(SettlementGetQueryParams), (_req: Request, res: Response) => {
    logger.debug({ query: res.locals.query }, 'GET /settlement');
    return res.json([]);
  });

  // ── Stats ──────────────────────────────────────────────────────────

  app.get('/stats', (_: Request, res: Response) => {
    logger.debug('GET /stats');
    return res.json([]);
  });

  app.get('/stats/history', (_: Request, res: Response) => {
    logger.debug('GET /stats/history');
    return res.json([]);
  });

  app.get('/stats/historyUSD', (_: Request, res: Response) => {
    logger.debug('GET /stats/historyUSD');
    return res.json([]);
  });

  // ── Trade ──────────────────────────────────────────────────────────

  app.get('/trade', validateQuery(TradeQuerySchema), async (_req: Request, res: Response) => {
    logger.debug({ query: res.locals.query }, 'GET /trade');
    const data = await fetchSnapshot(snapshotsUrl, 'trade');
    const filtered = filterSnapshotData(data, res.locals.query);
    return res.json(filtered);
  });

  app.get('/trade/bucketed', validateQuery(TradeQuerySchema), async (_req: Request, res: Response) => {
    logger.debug({ query: res.locals.query }, 'GET /trade/bucketed');
    // Use 1m binned trades (most common bucketed interval)
    const data = await fetchSnapshot(snapshotsUrl, 'tradeBin1m');
    const filtered = filterSnapshotData(data, res.locals.query);
    return res.json(filtered);
  });

  // ── Instrument ─────────────────────────────────────────────────────

  app.get('/instrument', validateQuery(InstrumentQuerySchema), async (_req: Request, res: Response) => {
    logger.debug({ query: res.locals.query }, 'GET /instrument');
    const data = await fetchSnapshot(snapshotsUrl, 'instrument');
    const filtered = filterSnapshotData(data, res.locals.query);
    return res.json(filtered);
  });

  app.get('/instrument/active', async (_: Request, res: Response) => {
    logger.debug('GET /instrument/active');
    const data = await fetchSnapshot(snapshotsUrl, 'instrument');
    const active = data ? data.filter((i: any) => i?.state === 'Open') : [];
    return res.json(active);
  });

  app.get('/instrument/indices', (_: Request, res: Response) => {
    logger.debug('GET /instrument/indices');
    return res.json([]);
  });

  app.get('/instrument/activeAndIndices', async (_: Request, res: Response) => {
    logger.debug('GET /instrument/activeAndIndices');
    const data = await fetchSnapshot(snapshotsUrl, 'instrument');
    return res.json(data || []);
  });

  app.get('/instrument/activeIntervals', (_: Request, res: Response) => {
    logger.debug('GET /instrument/activeIntervals');
    return res.json([]);
  });

  app.get('/instrument/compositeIndex', (req: Request, res: Response) => {
    const query = req.query as any;
    logger.debug({ query }, 'GET /instrument/compositeIndex');
    // No snapshot table available for composite index
    return res.json([]);
  });

  app.get('/instrument/usdVolume', async (_: Request, res: Response) => {
    logger.debug('GET /instrument/usdVolume');
    const data = await fetchSnapshot(snapshotsUrl, 'instrument');
    return res.json(data || []);
  });
};
