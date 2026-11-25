import { logger } from '@devvir/service-kit';
import { lensOf, noSuchLens } from '../lenses/requested';
import { MAX_REPORT, Refused, keysIn, reportOf, resolveReport, settle } from '../reports';
import { answer, failed } from './listings';
import type { Application } from 'express';
import type { DatabaseSync } from 'node:sqlite';

/**
 * What became of the files a client was listed, by Key, through the lens it
 * listed them through — see `reports.ts`.
 *
 * **`200` where every key was settled, `207` where some were not**, with only
 * those in the body, as S3's quiet `DeleteObjects` answers: the request
 * succeeded, its parts may not have, and the status says whether to look. A
 * whole request refused is a status of its own:
 *
 * - `400 MalformedReport`: the body is not a report; `400 InvalidArgument`: it
 *   names more keys than one report may.
 * - `422 NoSuchLens`: the lens it reads through does not exist.
 * - `400 ReportRefused`: prospector refused the report as it stands, with what it
 *   said — sending it again is refused again.
 * - `502 CollectorError`: prospector failed settling it.
 * - `502 ServiceUnavailable`: prospector did not answer, or not in time.
 */
export const mountReports = (app: Application, db: DatabaseSync): void => {
  app.post('/listings/report', async (req, res) => {
    const lens = lensOf(db, req);

    if (lens === undefined) return failed(req, res, 422, 'NoSuchLens', noSuchLens(req));

    const asked = reportOf(req.body);

    if (! asked) return failed(req, res, 400, 'MalformedReport', MALFORMED);

    if (keysIn(asked) > MAX_REPORT) return failed(req, res, 400, 'InvalidArgument', `At most ${MAX_REPORT} keys per report`);

    const resolved = resolveReport(db, asked, lens);

    try {
      await settle(resolved.settle);
    } catch (err) {
      logger.warn({ err }, 'Prospector did not settle a report');

      if (err instanceof Refused && err.status < 500) return failed(req, res, 400, 'ReportRefused', err.message);
      if (err instanceof Refused) return failed(req, res, 502, 'CollectorError', err.message);

      return failed(req, res, 502, 'ServiceUnavailable', 'The collector is not answering; report again later');
    }

    answer(req, res, resolved.errors.length === 0 ? 200 : 207, 'ReportResult',
      resolved.errors.length === 0 ? {} : { Error: resolved.errors });
  });
};

// ── Internals ─────────────────────────────────────────────────────────────────

const MALFORMED = 'A report is downloaded and failed, each a list of keys, and mismatched, a list of { Key, Size, ETag }:'
  + ' Size a whole number and ETag a string, each optional';
