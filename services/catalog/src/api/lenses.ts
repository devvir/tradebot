import { logger } from '@devvir/service-kit';
import {
  lensNameIsSound, lensNamed, lensOptions, lensSize, lenses, problemsWith, resolvedSummary,
} from '@tradebot/lenses';
import { savedLensSize } from '../lenses/figures';
import { send } from '../prospector';
import type { Application, Response } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import type { LensDefinition, LensProblem, LensWrite } from '../types';

/**
 * The lens endpoints.
 *
 * **A lens is read whole and written whole**, so there is no `PATCH` of one rule
 * and rules need no ids — their position in the array is what identifies them.
 * Every write, and every definition asked about, is checked first and refused
 * with what is wrong in a person's words: nothing is evaluated or handed on
 * that is not a definition every evaluation can read.
 *
 * **A lens is stored by prospector, never here.** A write that passes is handed
 * to it, and what it answers is what the caller is told — see `stored`.
 *
 * Applying a lens to the rest of the API is a separate thing and lives elsewhere:
 * these endpoints are how one is defined, not how one is used.
 */
export const mountLenses = (app: Application, db: DatabaseSync): void => {
  app.get('/lenses', (_req, res) => {
    res.json({ items: lenses(db) });
  });

  /**
   * **What the venues publish**: every combination that exists, each with the
   * venue it is of. Registered before a lens is asked for by its slug, which
   * this path would otherwise be taken for.
   */
  app.get('/lenses/options', (_req, res) => {
    res.json({ items: lensOptions(db) });
  });

  app.get('/lenses/:slug', (req, res) => {
    const found = lensNamed(db, String(req.params['slug']));

    if (! found) {
      res.status(404).json({ error: 'No such lens' });

      return;
    }

    res.json(found);
  });

  app.post('/lenses', async (req, res) => {
    const write = lensWriteOf(db, res, req.body, 'create');

    if (! write) return;

    await stored(res, 'POST', '/lenses', { ...write, name: write.name ?? '', note: write.note ?? '' });
  });

  /** Replace a lens, whole — its name, its note, its definition, or all three. */
  app.put('/lenses/:slug', async (req, res) => {
    const slug = soundSlug(res, req.params['slug']);

    if (! slug) return;

    const write = lensWriteOf(db, res, req.body ?? {}, 'replace');

    if (! write) return;

    await stored(res, 'PUT', `/lenses/${encodeURIComponent(slug)}`, write);
  });

  app.delete('/lenses/:slug', async (req, res) => {
    const slug = soundSlug(res, req.params['slug']);

    if (! slug) return;

    await stored(res, 'DELETE', `/lenses/${encodeURIComponent(slug)}`);
  });

  /**
   * **What a definition would cost, before it is stored.** It takes the
   * definition in the body, so one not yet stored can be sized.
   */
  app.post('/lenses/size', (req, res) => {
    const definition = definitionOf(db, res, req.body);

    if (definition) res.json(lensSize(db, definition));
  });

  /** The same, for a lens that exists — summed off its rows, so nothing is evaluated — and whether it is still being worked out. */
  app.get('/lenses/:slug/size', (req, res) => {
    const found = lensNamed(db, String(req.params['slug']));

    if (! found) {
      res.status(404).json({ error: 'No such lens' });

      return;
    }

    // While the lens is being worked out its rows are part of the old rules' and part of the new: the caller is told.
    res.json({ ...savedLensSize(db, found), updating: found.updating });
  });

  /**
   * Whether a definition can be stored, and what is wrong where it cannot:
   * `{ problems: [] }` where it can, a `400` with the problems where it cannot.
   */
  app.post('/lenses/check', (req, res) => {
    if (definitionOf(db, res, req.body)) res.json({ problems: [] });
  });

  /**
   * **What it actually selects**, by venue: how many series, and their spans.
   * The honest answer to "did I mean that", and what a size is computed from.
   */
  app.post('/lenses/resolve', (req, res) => {
    const definition = definitionOf(db, res, req.body);

    if (definition) res.json({ venues: resolvedSummary(db, definition) });
  });
};

// ── Internals ─────────────────────────────────────────────────────────────────

/**
 * Have prospector store what was asked, and answer with what it said: its
 * status and its body, as they are. `502` where it does not answer, or not in
 * time — see `send` for what is tried again first.
 *
 * **What is relayed is always JSON.** An answer that is not — a proxy's or a
 * framework's page — is logged and answered with an error of the same status,
 * or `502` where prospector failed.
 */
const stored = async (res: Response, method: string, path: string, body?: unknown): Promise<void> => {
  try {
    const answer = await send(method, path, body);

    if (answer.body === null) {
      res.status(answer.status).end();
    } else if (typeof answer.body === 'string') {
      logger.warn({ status: answer.status, body: answer.body }, 'Prospector answered a lens write with something that is not JSON');

      res.status(answer.status >= 500 ? 502 : answer.status).json({ error: 'The collector refused the request' });
    } else {
      res.status(answer.status).json(answer.body);
    }
  } catch (err) {
    logger.warn({ err }, 'Prospector did not store a lens');

    res.status(502).json({ error: 'The collector is not answering; try again shortly' });
  }
};

const SLUG_IS = 'A lens is addressed in lower case, digits and hyphens, two characters or more.';

/**
 * Slugs a lens cannot take: each is a path of its own under `/lenses`, so a
 * lens by that name could not be addressed as one.
 */
const RESERVED = new Set(['options', 'size', 'check', 'resolve']);

/** Whether a slug is text a lens can be addressed by. */
const slugIsSound = (slug: unknown): slug is string =>
  typeof slug === 'string' && lensNameIsSound(slug) && ! RESERVED.has(slug);

/** The slug a path names, or `null` (answered `404`) where no lens could be addressed by it. */
const soundSlug = (res: Response, slug: unknown): string | null => {
  if (typeof slug === 'string' && lensNameIsSound(slug)) return slug;

  res.status(404).json({ error: 'No such lens' });

  return null;
};

/**
 * A lens write as a body states it, or `null` (answered `400`) where the body
 * is not one.
 *
 * A body is a document of a slug, a name, a note and a definition, each of its
 * kind where present; a create needs the slug. A definition is one every
 * evaluation can read — see `definitionProblems`. Only those four parts are
 * handed on.
 */
const lensWriteOf = (db: DatabaseSync, res: Response, body: unknown, as: 'create' | 'replace'): LensWrite | null => {
  if (! plain(body)) {
    res.status(400).json({ error: 'A lens is written as a document of its slug, name, note and definition.' });

    return null;
  }

  const { slug, name, note, definition } = body;

  if ((as === 'create' || slug !== undefined) && ! slugIsSound(slug)) {
    res.status(400).json({ error: SLUG_IS });

    return null;
  }

  for (const [field, value] of [['name', name], ['note', note]] as const)
    if (value !== undefined && typeof value !== 'string') {
      res.status(400).json({ error: `A lens's ${field} is text.` });

      return null;
    }

  if (definition !== undefined && ! refused(res, 'That definition cannot be stored', definitionProblems(db, definition)))
    return null;

  return {
    slug:       slug as string | undefined,
    name:       name as string | undefined,
    note:       note as string | undefined,
    definition: definition as LensDefinition | undefined,
  };
};

/**
 * The definition a request asks about — its body's `definition`, or the body
 * itself — or `null` (answered `400` with its problems) where it is not one that
 * can be evaluated. Nothing is evaluated before it passes.
 */
const definitionOf = (db: DatabaseSync, res: Response, body: unknown): LensDefinition | null => {
  const had = plain(body) && body['definition'] !== undefined ? body['definition'] : (body ?? {});

  if (! refused(res, 'That definition cannot be evaluated', definitionProblems(db, had))) return null;

  const { format, venues } = had as Partial<LensDefinition>;

  return { format: format ?? 1, venues: venues ?? {} };
};

/**
 * What is wrong with a definition, as `problemsWith` says. A check that fails
 * on what it is handed says the definition is not one, rather than failing the
 * request.
 */
const definitionProblems = (db: DatabaseSync, definition: unknown): LensProblem[] => {
  try {
    return problemsWith(db, definition);
  } catch (err) {
    logger.warn({ err }, 'A lens definition could not be checked');

    return [{ venue: '', rule: -1, message: 'A definition is a document of venues, each with its rules.' }];
  }
};

/** Whether there is nothing wrong; where there is, answers `400` with `error` and the problems. */
const refused = (res: Response, error: string, problems: LensProblem[]): boolean => {
  if (problems.length === 0) return true;

  res.status(400).json({ error, problems });

  return false;
};

/** Whether something is a document of named parts: an object, and not a list. */
const plain = (one: unknown): one is Record<string, unknown> =>
  typeof one === 'object' && one !== null && ! Array.isArray(one);
