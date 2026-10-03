import { logger } from '@devvir/service-kit';
import { lensRequested, lensSlug } from '../lenses/requested';
import { MAX_REPORT, keysIn, resolveReport, settle } from '../reports';
import { answer, failed } from './listings';
import type { Application } from 'express';
import type { DatabaseSync } from 'node:sqlite';

/**
 * What became of the files a downloader was listed, by Key, through the lens it
 * listed them through — see `reports.ts`.
 *
 * **`200` where every key was settled, `207` where some were not**, with only
 * those in the body, as S3's quiet `DeleteObjects` answers: the request
 * succeeded, its parts may not have, and the status says whether to look. A
 * whole request refused is a status of its own — malformed (`400`), too long
 * (`400`), an unknown lens (`422`), prospector not answering (`502`).
 */
export const mountReports = (app: Application, db: DatabaseSync): void => {
  app.post('/listings/report', async (req, res) => {
    const lens = lensRequested(db, req);

    if (lens === undefined) return failed(req, res, 422, 'NoSuchLens', `No such lens: ${lensSlug(req)}`);

    if (keysIn(req.body) > MAX_REPORT) return failed(req, res, 400, 'InvalidArgument', `At most ${MAX_REPORT} keys per report`);

    const resolved = resolveReport(db, req.body, lens?.lens ?? null);

    if (! resolved) return failed(req, res, 400, 'MalformedReport', 'A report is downloaded and failed, each a list of keys, and mismatched, a list of { Key, Size, ETag }');

    try {
      await settle(resolved.settle);
    } catch (err) {
      logger.warn({ err }, 'Prospector did not settle a report');

      return failed(req, res, 502, 'ServiceUnavailable', 'The collector is not answering; report again later');
    }

    answer(req, res, resolved.errors.length === 0 ? 200 : 207, 'ReportResult',
      resolved.errors.length === 0 ? {} : { Error: resolved.errors });
  });
};
