import express, { type Request, type Response } from 'express';
import { logger, type Service } from '@devvir/service-kit';
import type { BitmexTable, Database } from '@devvir/bitmex-database';

const HTTP_PORT = 80;

export const startSnapshotServer = (service: Service): void => {
  const app = express();

  app.get('/snapshot/:table', (req: Request, res: Response) => {
    const table   = req.params['table'] as string;
    const symbol  = typeof req.query.symbol  === 'string' ? req.query.symbol  : undefined;
    const account = typeof req.query.account === 'string' ? req.query.account : undefined;

    serveSnapshot(service, res, table, symbol, account);
  });

  app.listen(HTTP_PORT, () => {
    logger.info(`Snapshot HTTP server listening on port ${HTTP_PORT}`);
  });
};

const serveSnapshot = (
  service: Service,
  res:     Response,
  table:   string,
  symbol:  string | undefined,
  account: string | undefined,
): void => {
  const db       = service.state('database') as Database;
  const tables   = service.state('tables')   as Set<string>;
  const counters = service.state('counters') as Record<string, number>;

  if (! tables.has(table)) {
    res.status(404).json({ error: `No snapshot for table '${table}'` });
    return;
  }

  let data = db.snapshot(table as BitmexTable);

  const view = db.view(table as BitmexTable);
  const filter: Record<string, string> = {};

  if (symbol && 'symbol' in view.types) {
    filter.symbol = symbol;
    data = data.filter(r => (r as Record<string, unknown>).symbol === symbol);
  }

  if (account && 'account' in view.types) {
    filter.account = account;
    data = data.filter(r => Number((r as Record<string, unknown>).account) === Number(account));
  }

  res.json({
    table:   view.table,
    keys:    view.keys,
    types:   view.types,
    filter,
    data,
    counter: counters[table] ?? 0,
  });
};
