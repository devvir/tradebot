import { logger } from '@devvir/service-kit';
import config from '../config';
import type { Application } from 'express';

/**
 * What became of a page of a listing, forwarded to prospector as it is.
 *
 * **Public here, settled there.** Reporting is part of what a downloader does
 * against the catalog, so it is reached where the listing is; but recording it
 * is a write, and prospector is the one service that writes the files it
 * describes. Nothing here reads the body: the answer, status and all, is
 * prospector's.
 */
export const mountReports = (app: Application): void => {
  app.post('/listings/:venue/report', async (req, res) => {
    const url = `${config.prospectorApi}/reports/${encodeURIComponent(String(req.params['venue']))}`;

    try {
      const answer = await fetch(url, {
        method:  'POST',
        headers: {
          'content-type': 'application/json',
          ...(config.token ? { 'x-catalog-token': config.token } : {}),
        },
        body: JSON.stringify(req.body ?? {}),
      });

      res.status(answer.status).type('application/json').send(await answer.text());
    } catch (err) {
      logger.warn({ err, url }, 'Prospector did not answer a report');

      res.status(502).json({ error: 'The collector is not answering; report again later' });
    }
  });
};
