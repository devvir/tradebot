import { contentsOf, venueContents } from '../contents';
import { lensRequested } from '../lenses/requested';
import { venueIds } from '../queries';
import { GRAINS } from '../vocabulary';
import type { Application, Request, Response } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import type { ContentsAsked, Grain, RequestedLens } from '../types';

/**
 * What the catalog holds, walked one level at a time: venues, then a venue's
 * markets, then one row per `(dataset, variant, grain)` a market publishes, with
 * the instruments asked for beside them.
 *
 * **Every view can be seen through a lens** named in `x-catalog-lens`; an
 * unknown one is a `404`, never the whole catalog in its place.
 */
export const mountContents = (app: Application, db: DatabaseSync): void => {
  app.get('/contents/venues', (req, res) => {
    const lens = lensed(db, req, res);

    if (lens !== undefined) res.json({ items: venueContents(db, lens) });
  });

  app.get('/contents/venues/:venue', (req, res) => venue(db, req, res, 'markets'));
  app.get('/contents/venues/:venue/symbols', (req, res) => venue(db, req, res, 'symbols'));
  app.get('/contents/venues/:venue/markets/:market', (req, res) => venue(db, req, res, 'shapes'));
  app.get('/contents/venues/:venue/markets/:market/symbols', (req, res) => venue(db, req, res, 'symbols'));
};

// ── Internals ─────────────────────────────────────────────────────────────────

/** One venue's markets, shapes or instruments, narrowed by the query's filters. */
const venue = (db: DatabaseSync, req: Request, res: Response, give: ContentsAsked['give']): void => {
  const name = String(req.params['venue']);

  if (venueIds(db, name).length === 0) {
    res.status(404).json({ error: 'No such venue' });

    return;
  }

  const grain = text(req.query['grain']);

  if (grain !== undefined && ! (GRAINS as readonly string[]).includes(grain)) {
    res.status(400).json({ error: `grain must be one of ${GRAINS.join(', ')}` });

    return;
  }

  const lens = lensed(db, req, res);

  if (lens === undefined) return;

  const market  = text(req.params['market']) ?? text(req.query['market']);
  const dataset = text(req.query['dataset']);
  const variant = text(req.query['variant']);

  res.json({ items: contentsOf(db, name, { give, filter: {
    ...(market  ? { market }  : {}),
    ...(dataset ? { dataset } : {}),
    ...(variant ? { variant } : {}),
    ...(grain   ? { grain: grain as Grain } : {}),
  } }, lens) });
};

/** The request's lens, or `undefined` once an unknown one has been answered `404`. */
const lensed = (db: DatabaseSync, req: Request, res: Response): RequestedLens | null | undefined => {
  const held = lensRequested(db, req);

  if (held === undefined) res.status(422).json({ error: `No such lens: ${String(req.headers['x-catalog-lens']).trim()}` });

  return held;
};

const text = (raw: unknown): string | undefined =>
  (typeof raw === 'string' && raw !== '' ? raw : undefined);
