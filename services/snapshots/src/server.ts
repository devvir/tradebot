import express, { type Request, type Response } from 'express';
import { logger, type Service } from '@devvir/service-kit';
import type { BitmexDataItem, BitmexDataItemWithSymbol, BitmexTable, SnapshotIndexedData, State } from './types';

const HTTP_PORT = 3001;

export const startSnapshotServer = (service: Service): void => {
  const app = express();

  app.get('/snapshot/:table', (req: Request, res: Response) => {
    const { table } = req.params;
    const { symbol } = req.query;

    const state = service.state('snapshots') as State['snapshots'];
    const snapshot = state[table as BitmexTable];

    if (! snapshot) {
      res.status(404).json({ error: `No snapshot for table '${table}'` });
      return;
    }

    let data = snapshot.data;
    const filterBySymbol = symbol && 'symbol' in snapshot.types;

    if (snapshot.keys.length)
      data = [...(snapshot.data as SnapshotIndexedData).values()] as BitmexDataItem[];

    const filter = filterBySymbol ? { symbol } : {};
    const rows = data as BitmexDataItemWithSymbol[];
    data = filterBySymbol ? rows.filter(row => row.symbol === symbol) : rows;

    res.json({ ...snapshot, data, filter });
  });

  app.listen(HTTP_PORT, () => {
    logger.info(`Snapshot HTTP server listening on port ${HTTP_PORT}`);
  });
};
