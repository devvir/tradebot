import express, { type Request, type Response } from 'express';
import { logger, type Service } from '@devvir/service-kit';
import type { BitmexTable, Database } from '@devvir/bitmex-database';
import { PRIVATE_TABLES, servePrivateSnapshot } from './private';

const HTTP_PORT = 3001;

export const startSnapshotServer = (service: Service): void => {
  const app = express();

  app.get('/snapshot/:table', async (req: Request, res: Response) => {
    const table   = req.params['table'] as string;
    const symbol  = typeof req.query.symbol  === 'string' ? req.query.symbol  : undefined;
    const account = typeof req.query.account === 'string' ? req.query.account : undefined;

    if (PRIVATE_TABLES.has(table)) {
      return await servePrivateSnapshot(service, res, table, account, symbol);
    }

    servePublicSnapshot(service, res, table, symbol);
  });

  app.listen(HTTP_PORT, () => {
    logger.info(`Snapshot HTTP server listening on port ${HTTP_PORT}`);
  });
};

const servePublicSnapshot = (
  service: Service,
  res:     Response,
  table:   string,
  symbol:  string | undefined,
): void => {
  const db       = service.state('database')  as Database;
  const tables   = service.state('tables')    as Set<string>;
  const counters = service.state('counters')  as Record<string, number>;

  if (! tables.has(table)) {
    res.status(404).json({ error: `No snapshot for table '${table}'` });
    return;
  }

  const view     = db.view(table as BitmexTable);
  const snapshot = db.snapshot(table as BitmexTable);

  const filterBySymbol = symbol && 'symbol' in view.types;

  let data = filterBySymbol
    ? snapshot.filter((item: unknown) => (item as Record<string, unknown>)['symbol'] === symbol)
    : snapshot;

  // Insert-only tables send partial snapshots.
  // Real BitMEX: ~1000 recent trades, ~100 recent quotes
  if (table === 'trade') data = data.slice(-1000);
  if (table === 'quote') data = data.slice(-100);

  res.json({
    table:   view.table,
    keys:    view.keys,
    types:   view.types,
    data,
    counter: counters[table] ?? 0,
    filter:  filterBySymbol ? { symbol } : {},
  });
};
