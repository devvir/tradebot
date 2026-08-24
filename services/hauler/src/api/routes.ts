import { unwant, want, wants } from '../wanted';
import { ANY, DATASETS, MARKETS } from '../types';
import type { Application, Request } from 'express';
import type { Dataset, Market, Want } from '../types';

/**
 * The shopping list, over HTTP.
 *
 * **The only thing hauler exposes**, because it is the only thing about hauler
 * that a person decides. What is on disk is the catalog's to report and which
 * partitions are finished is a fact in the shared database; both have better
 * places to be asked than a port here.
 *
 * A want is one dataset of one venue, named as the catalog names it, with the
 * months it covers and what it should get of that dataset. Adding one already
 * listed replaces it rather than duplicating it — the facts database keys the
 * row by exactly the three fields that identify a want, so that falls out rather
 * than being arranged.
 */
export const setupRoutes = (app: Application): void => {
  /** Everything wanted, or one venue's worth. */
  app.get('/wanted', (req, res) => {
    const venue = optional(req.query['venue']);

    res.json({ items: wants(venue ? [venue] : []) });
  });

  /**
   * Add one, or change the range of one already listed.
   *
   * `PUT` rather than `POST` deliberately: stating a want is idempotent, and
   * saying it twice must not leave two of them.
   */
  app.put('/wanted', (req, res) => {
    const asked = wanted(req);

    if (typeof asked === 'string') {
      res.status(400).json({ error: asked });

      return;
    }

    res.json({ wanted: want(asked) });
  });

  /**
   * Drop one.
   *
   * **A dataset of a venue is one want**, so naming those three is naming it
   * whole — there is no half of it to leave behind, whatever bounds or
   * requirements it was listed with.
   */
  app.delete('/wanted', (req, res) => {
    const asked = wanted(req);

    if (typeof asked === 'string') {
      res.status(400).json({ error: asked });

      return;
    }

    res.json({ dropped: unwant(asked) });
  });
};

// ── Internals ─────────────────────────────────────────────────────────────────

/**
 * A want from a request, or the reason it is not one.
 *
 * Takes its fields from the body or the query string without caring which: this
 * is a list somebody maintains by hand as often as by script, and `curl -X
 * DELETE '…/wanted?venue=gate&market=spot&dataset=deals'` should work.
 *
 * **Nothing is validated against the catalog here.** Whether a venue publishes
 * `futures_usdt/candlesticks_1m` is a question with an authoritative answer one
 * HTTP call away, and a copy of that answer in here would be a second thing to
 * keep in step. A want for something nobody publishes simply lists nothing.
 */
const wanted = (req: Request): Want | string => {
  const from = (name: string): string | undefined =>
    optional((req.body as Record<string, unknown> | undefined)?.[name]) ?? optional(req.query[name]);

  const venue   = from('venue');
  const market  = from('market');
  const dataset = from('dataset');

  if (! venue || ! market || ! dataset)
    return 'venue, market and dataset are all required';

  /**
   * **Canonical names only, and the error says so with the list.**
   *
   * A want is written in the vocabulary the archives are arranged by, not in the
   * venue's — `perp` and `klines`, never `futures_usdt` and `candlesticks_1m`.
   * That is not pedantry: one canonical dataset is fed by several of a venue's
   * own, and a want naming one of them would quietly fetch a fraction of what
   * was meant. Accepting the wrong vocabulary is how that goes unnoticed.
   */
  if (market !== ANY && ! isMarket(market))
    return `market must be canonical, one of: ${MARKETS.join(', ')}, ${ANY} — got '${market}'`;

  if (dataset !== ANY && ! isDataset(dataset))
    return `dataset must be canonical, one of: ${DATASETS.join(', ')}, ${ANY} — got '${dataset}'`;

  const bounds = ['from', 'to'] as const;

  for (const name of bounds) {
    const at = from(name);

    if (at !== undefined && ! /^\d{6}$/.test(at))
      return `${name} must be a yyyymm month, got '${at}'`;
  }

  /**
   * **The requirements come as objects, and nothing here interprets them.**
   * Which keys mean something is `plan.ts`'s business and depends on what the
   * catalog turns out to publish, so validating them here would be a second
   * opinion about a question this service answers elsewhere. What is checked is
   * that they are objects of strings, which is the only thing that could make
   * the planner fail in a way the caller cannot see.
   */
  const fixed  = shaped(req, 'fixed');
  const prefer = shaped(req, 'prefer');

  if (typeof fixed === 'string') return fixed;

  if (typeof prefer === 'string') return prefer;

  /**
   * **A wildcard dataset and a requirement are alternatives, not a combination.**
   *
   * `fixed` and `prefer` are resolved across everything a want selects, so with
   * one dataset they narrow *within* it and with `*` they narrow *between*
   * datasets — `{ interval: 'min' }` keeps whatever carries the finest bars and
   * drops trades, books and funding entirely, having never mentioned them. The
   * one that says "prefer" is the worse of the two, because it is defined to
   * fall back rather than to exclude and here it would do neither visibly.
   *
   * So it is refused at the door. Fetch everything a venue publishes, or state
   * what a named dataset must look like — asking for both is a sentence with no
   * consistent reading.
   */
  if (dataset === ANY && (fixed || prefer))
    return `dataset '${ANY}' takes no fixed or prefer: a requirement is resolved across every `
      + 'dataset it selects, so it would silently drop the ones that cannot satisfy it. '
      + 'Name a dataset, or drop the requirement.';

  return {
    venue,
    market,
    dataset,
    ...optionally('from', from('from')),
    ...optionally('to', from('to')),
    ...(fixed ? { fixed } : {}),
    ...(prefer ? { prefer } : {}),
  };
};

/**
 * One of the two requirement objects, or the reason it is not one.
 *
 * Accepted from the body as an object, and from the query string as
 * `fixed.grain=monthly` — because this is a list maintained by hand as often as
 * by script, and `curl` should be able to state a whole want.
 */
const shaped = (req: Request, name: string): Record<string, string> | undefined | string => {
  const body = (req.body as Record<string, unknown> | undefined)?.[name];
  const held: Record<string, string> = {};

  if (body !== undefined) {
    if (typeof body !== 'object' || body === null || Array.isArray(body))
      return `${name} must be an object of level names to values`;

    for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
      if (typeof value !== 'string')
        return `${name}.${key} must be a string, got ${typeof value}`;

      held[key] = value;
    }
  }

  for (const [key, value] of Object.entries(req.query)) {
    if (! key.startsWith(`${name}.`)) continue;

    const level = key.slice(name.length + 1);
    const asked = optional(value);

    if (! level || ! asked) return `${key} names no value`;

    held[level] = asked;
  }

  return Object.keys(held).length > 0 ? held : undefined;
};

const isMarket = (value: string): value is Market =>
  (MARKETS as readonly string[]).includes(value);

const isDataset = (value: string): value is Dataset =>
  (DATASETS as readonly string[]).includes(value);

const optional = (value: unknown): string | undefined =>
  (typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined);

const optionally = (name: string, value: string | undefined): Record<string, string> =>
  value === undefined ? {} : { [name]: value };

// ── Test access ───────────────────────────────────────────────────────────────

export const _test_wanted = wanted;
