import { contentsOf, venueContents } from '../contents';
import { lensRequested, noSuchLens } from '../lenses/requested';
import { partitionContents } from '../partitions';
import { venueIds } from '../queries';
import { INVALID, flag, grainOf, queryText } from './query';
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
 * a `422`, never the whole catalog in its place. A query parameter given more
 * than once is a `400`.
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
   * **A venue's partitions**, slice by slice, with their counts and versions,
   * narrowed by the query. Unpaged — a venue is a few thousand of them.
   */
  app.get('/venues/:venue/partitions', (req, res) => {
    const name = String(req.params['venue']);

    if (venueIds(db, name).length === 0) {
      res.status(404).json({ error: 'No such venue' });

      return;
    }

    const asked = textsOf(req, res, ['grain', 'bundle', 'market', 'datasets', 'variant', 'settled-before']);

    if (! asked) return;

    const grain = grainIn(res, asked.grain);

    if (grain === null) return;

    const { bundle } = asked;

    if (bundle !== undefined && bundle !== 'instrument' && bundle !== 'market') {
      res.status(400).json({ error: 'bundle must be instrument or market' });

      return;
    }

    const settled = flagOf(req, res, 'settled');

    if (settled === null) return;

    const downloaded = flagOf(req, res, 'downloaded');

    if (downloaded === null) return;

    const before = instantOf(res, asked['settled-before']);

    if (before === null) return;

    const lens = lensed(db, req, res);

    if (lens === undefined) return;

    const { market, variant } = asked;
    const datasets = asked.datasets?.split(',').map(one => one.trim()).filter(one => one !== '');

    res.json({ items: partitionContents(db, name, {
      ...(market   ? { market }   : {}),
      ...(datasets ? { datasets } : {}),
      ...(variant  ? { variant }  : {}),
      ...(grain    ? { grain }    : {}),
      ...(bundle   ? { bundle: bundle as Bundle } : {}),
      ...(downloaded ? { downloaded: true } : {}),
      ...(settled  ? { settled: true } : {}),
      ...(before   ? { settledBefore: before } : {}),
    }, lens?.lens ?? null) });
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

  const asked = textsOf(req, res, ['grain', 'market', 'dataset', 'variant']);

  if (! asked) return;

  const grain = grainIn(res, asked.grain);

  if (grain === null) return;

  const lens = lensed(db, req, res);

  if (lens === undefined) return;

  const market  = req.params['market'] ? String(req.params['market']) : asked.market;
  const { dataset, variant } = asked;

  res.json({ items: contentsOf(db, name, { give, filter: {
    ...(market  ? { market }  : {}),
    ...(dataset ? { dataset } : {}),
    ...(variant ? { variant } : {}),
    ...(grain   ? { grain }   : {}),
  } }, lens) });
};

/** The request's lens, or `undefined` once an unknown one has been answered `422`. */
const lensed = (db: DatabaseSync, req: Request, res: Response): RequestedLens | null | undefined => {
  const held = lensRequested(db, req);

  if (held === undefined) res.status(422).json({ error: noSuchLens(req) });

  return held;
};

/** The query's text parameters by name, or null once one given more than once has been answered `400`. */
const textsOf = <Name extends string>(req: Request, res: Response, names: readonly Name[]): Partial<Record<Name, string>> | null => {
  const texts: Partial<Record<Name, string>> = {};

  for (const name of names) {
    const one = queryText(req.query[name]);

    if (one === INVALID) {
      res.status(400).json({ error: `${name} may be given once` });

      return null;
    }

    if (one !== undefined) texts[name] = one;
  }

  return texts;
};

/** A grain — see `grainOf` — `undefined` where none was given, or null once anything else has been answered `400`. */
const grainIn = (res: Response, given: string | undefined): Grain | undefined | null => {
  const grain = grainOf(given);

  if (grain === 'invalid') {
    res.status(400).json({ error: `grain must be one of ${GRAINS.join(', ')}` });

    return null;
  }

  return grain;
};

/** A yes-or-no parameter — see `flag` — false where absent, or null once anything else has been answered `400`. */
const flagOf = (req: Request, res: Response, name: string): boolean | null => {
  const given = flag(req.query[name]);

  if (given === 'invalid') {
    res.status(400).json({ error: `${name} must be true or false` });

    return null;
  }

  return given === true;
};

/**
 * An instant as `toISOString` writes it — in UTC, so it compares as text with
 * the instants the catalog holds — from any ISO 8601 date, or date and time
 * with its offset. `undefined` where none was given, null once anything else
 * has been answered `400`.
 */
const instantOf = (res: Response, given: string | undefined): string | undefined | null => {
  if (given === undefined) return undefined;

  const ms = Date.parse(given);

  if (Number.isNaN(ms) || ! INSTANT.test(given)) {
    res.status(400).json({ error: 'settled-before must be an ISO 8601 instant' });

    return null;
  }

  return new Date(ms).toISOString();
};

/** A date, or a date and time that says its offset: one without would be read in the server's own zone. */
const INSTANT = /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:\d{2}))?$/i;
