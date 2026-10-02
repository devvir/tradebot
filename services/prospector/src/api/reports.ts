import { venueIds } from '../catalog';
import { MAX_REPORT, settleById } from '../reports';
import type { Application } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import type { ReportedById } from '../types';

/**
 * The reports API: what became of the files a downloader was listed, by
 * `FileId`. Private — catalog forwards each report here as it was sent.
 */
export const mountReports = (app: Application, db: DatabaseSync): void => {
  app.post('/reports/:venue', async (req, res) => {
    const ids = venueIds(db, String(req.params['venue']));

    if (ids.length === 0) {
      res.status(404).json({ error: 'No such venue' });

      return;
    }

    const body  = (req.body ?? {}) as Partial<ReportedById>;
    const count = [body.downloaded, body.failed, body.mismatched]
      .reduce((sum, one) => sum + (Array.isArray(one) ? one.length : 0), 0);

    if (count > MAX_REPORT) {
      res.status(400).json({ error: `At most ${MAX_REPORT} files per report` });

      return;
    }

    res.json(await settleById(db, ids, body));
  });
};
