import { contentsOf, partitionsOfVenue, venueContents } from '../contents';
import { lensRequested, lensSlug } from '../lenses/requested';
import { venueIds } from '../queries';
import { GRAINS } from '../vocabulary';
import type { Application, Request, Response } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import type { Bundle, ContentsAsked, Grain, RequestedLens } from '../types';

/**
 * What the catalog holds, walked one level at a time: venues, then a venue's
 * markets, then one row per `(dataset, variant, grain)` a market publishes, with
 * the instruments asked for beside them.
 *
 * **Every view can be seen through a lens** — see `lensSlug`; an unknown one is
 * a `422`, never the whole catalog in its place.
 */
export const mountContents = (app: Application, db: DatabaseSync): void => {
  app.get('/venues', (req, res) => {
    const lens = lensed(db, req, res);

    if (lens !== undefined) res.json({ items: venueContents(db, lens) });
  });

  app.get('/venues/:venue', (req, res) => venue(db, req, res, 'markets'));
  app.get('/venues/:venue/symbols', (req, res) => venue(db, req, res, 'symbols'));
  app.get('/venues/:venue/markets/:market', (req, res) => venue(db, req, res, 'shapes'));
  app.get('/venues/:venue/markets/:market/symbols', (req, res) => venue(db, req, res, 'symbols'));

  /**
   * **A venue's partitions**, slice by slice: what a consumer that handles
   * partitions whole reads to decide what to do next. Unpaged — a venue is a
   * few thousand of them.
   */
  app.get('/venues/:venue/partitions', (req, res) => {
    const name = String(req.params['venue']);

    if (venueIds(db, name).length === 0) {
      res.status(404).json({ error: 'No such venue' });

      return;
    }

    const grain  = text(req.query['grain']);
    const bundle = text(req.query['bundle']);

    if (grain !== undefined && ! (GRAINS as readonly string[]).includes(grain)) {
      res.status(400).json({ error: `grain must be one of ${GRAINS.join(', ')}` });

      return;
    }

    if (bundle !== undefined && bundle !== 'instrument' && bundle !== 'market') {
      res.status(400).json({ error: 'bundle must be instrument or market' });

      return;
    }

    const lens = lensed(db, req, res);

    if (lens === undefined) return;

    const market   = text(req.query['market']);
    const datasets = text(req.query['datasets'])?.split(',').map(one => one.trim()).filter(one => one !== '');
    const variant  = text(req.query['variant']);
    const before   = text(req.query['settled-before']);

    res.json({ items: partitionsOfVenue(db, name, {
      ...(market   ? { market }   : {}),
      ...(datasets ? { datasets } : {}),
      ...(variant  ? { variant }  : {}),
      ...(grain    ? { grain: grain as Grain }    : {}),
      ...(bundle   ? { bundle: bundle as Bundle } : {}),
      ...(req.query['downloaded'] === 'true' ? { downloaded: true } : {}),
      ...(before   ? { settledBefore: before } : {}),
    }, lens) });
  });
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

/** The request's lens, or `undefined` once an unknown one has been answered `422`. */
const lensed = (db: DatabaseSync, req: Request, res: Response): RequestedLens | null | undefined => {
  const held = lensRequested(db, req);

  if (held === undefined) res.status(422).json({ error: `No such lens: ${lensSlug(req)}` });

  return held;
};

const text = (raw: unknown): string | undefined =>
  (typeof raw === 'string' && raw !== '' ? raw : undefined);
