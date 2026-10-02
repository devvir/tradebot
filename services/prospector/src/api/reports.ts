import { MAX_REPORT, settleById } from '../reports';
import type { Application } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import type { ReportedById } from '../types';

/**
 * The reports API: what became of the files a downloader was listed, by file
 * id — the row's own number, which is how this service names a file. Private:
 * the catalog resolves the keys a downloader reports by, and forwards the ids.
 */
export const mountReports = (app: Application, db: DatabaseSync): void => {
  app.post('/reports', async (req, res) => {
    const body  = (req.body ?? {}) as Partial<ReportedById>;
    const count = [body.downloaded, body.failed, body.mismatched]
      .reduce((sum, one) => sum + (Array.isArray(one) ? one.length : 0), 0);

    if (count > MAX_REPORT) {
      res.status(400).json({ error: `At most ${MAX_REPORT} files per report` });

      return;
    }

    res.json(await settleById(db, body));
  });
};
