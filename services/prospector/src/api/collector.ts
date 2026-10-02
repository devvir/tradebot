import { pauseSurveys, startSurveys, statusOf, venuesAsked } from '../collector';
import type { Application, Request, Response } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import type { Surveys } from '../types';

/**
 * The collector API: start, continue or pause the surveys, and see how every
 * venue stands. Private — reached only from inside the module, by catalog-ui.
 *
 * **`venue` is optional, and leaving it out means all of them**: a name, several
 * names, or none. `/venues/:venue/surveys` is the same request with the venue
 * named in the path. Named venues are checked against the registry, never the
 * `venue` table — that table is written by a survey, so on a fresh database no
 * first survey could otherwise start.
 */
export const mountCollector = (app: Application, db: DatabaseSync, surveys: Surveys): void => {
  app.post('/surveys', (req, res) => start(db, req, res, surveys));
  app.post('/venues/:venue/surveys', (req, res) => start(db, req, res, surveys));

  app.post('/surveys/pause', (req, res) => {
    const asked = askedOf(req, res, surveys);

    if (asked) res.json(pauseSurveys(surveys, asked));
  });

  app.get('/status', (req, res) => {
    const only = req.query['venue'];

    res.json({ items: statusOf(db, surveys, typeof only === 'string' && only ? only : undefined) });
  });
};

// ── Internals ─────────────────────────────────────────────────────────────────

/**
 * Start or continue. `refresh: true` throws the progress away first;
 * `update: true` skips the wait. They are mutually exclusive — one discards
 * what the other builds on.
 */
const start = (db: DatabaseSync, req: Request, res: Response, surveys: Surveys): void => {
  const refresh = req.body?.refresh === true;
  const forced  = req.body?.update === true;

  if (refresh && forced) {
    res.status(400).json({ error: 'refresh and update are mutually exclusive — one discards the progress the other builds on' });

    return;
  }

  const asked = askedOf(req, res, surveys);

  if (! asked) return;

  const answer = startSurveys(db, surveys, asked, refresh, forced);

  if ('refused' in answer) res.status(409).json({ error: answer.refused, skipped: answer.skipped });
  else res.json(answer);
};

/** The venues a request is about, or null once an unknown one has been answered `404`. */
const askedOf = (req: Request, res: Response, surveys: Surveys): string[] | null => {
  const known = surveys.venues();
  const asked = venuesAsked(req.params['venue'] ?? req.body?.venue, known);

  if (! Array.isArray(asked)) {
    res.status(404).json({ error: 'No such venue', unknown: asked.unknown, venues: known });

    return null;
  }

  return asked;
};
