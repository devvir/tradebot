import { logger } from '@devvir/service-kit';
import {
  lensNameIsSound, lensNamed, lensOptions, lensSize, lenses, problemsWith, resolvedSummary,
} from '@tradebot/lenses';
import { savedLensSize } from '../lenses/figures';
import { send } from '../prospector';
import type { Application, Request, Response } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import type { LensDefinition, LensWrite } from '../types';

/**
 * The lens endpoints.
 *
 * **A lens is read whole and written whole**, so there is no `PATCH` of one rule
 * and rules need no ids — their position in the array is what identifies them.
 * Every write validates first and says what is wrong in a person's words, because
 * the only consumer that writes here is a form.
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
   * **What the venues publish**, each combination with the venue it is of, so an
   * editor offers only combinations that exist rather than every string the
   * catalog has ever seen. Registered before a lens is asked for by its slug,
   * which this path would otherwise be taken for.
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
    const { slug, name, note, definition } = (req.body ?? {}) as LensWrite;

    if (! slug || ! lensNameIsSound(slug)) {
      res.status(400).json({
        error: 'A lens is addressed in lower case, digits and hyphens, two characters or more.',
      });

      return;
    }

    const problems = definition ? problemsWith(db, definition) : [];

    if (problems.length > 0) {
      res.status(400).json({ error: 'That definition cannot be stored', problems });

      return;
    }

    await stored(res, 'POST', '/lenses', { slug, name: name ?? '', note: note ?? '', definition });
  });

  /** Replace a lens, whole — its name, its note, its definition, or all three. */
  app.put('/lenses/:slug', async (req, res) => {
    const slug = String(req.params['slug']);

    const to = (req.body ?? {}) as LensWrite;

    if (to.slug !== undefined && ! lensNameIsSound(to.slug)) {
      res.status(400).json({
        error: 'A lens is addressed in lower case, digits and hyphens, two characters or more.',
      });

      return;
    }

    if (to.definition) {
      const problems = problemsWith(db, to.definition);

      if (problems.length > 0) {
        res.status(400).json({ error: 'That definition cannot be stored', problems });

        return;
      }
    }

    await stored(res, 'PUT', `/lenses/${encodeURIComponent(slug)}`, to);
  });

  app.delete('/lenses/:slug', async (req, res) => {
    await stored(res, 'DELETE', `/lenses/${encodeURIComponent(String(req.params['slug']))}`);
  });

  /**
   * **What a definition would cost, before it is stored.** The editor asks on
   * every change, so this takes the document in the body rather than reading a
   * saved one.
   */
  app.post('/lenses/size', (req, res) => {
    res.json(lensSize(db, definitionOf(req)));
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

  /** Whether a definition can be stored, and what is wrong where it cannot. */
  app.post('/lenses/check', (req, res) => {
    res.json({ problems: problemsWith(db, definitionOf(req)) });
  });

  /**
   * **What it actually selects**, by venue: how many series, and their spans.
   * The honest answer to "did I mean that", and what a size is computed from.
   */
  app.post('/lenses/resolve', (req, res) => {
    res.json({ venues: resolvedSummary(db, definitionOf(req)) });
  });
};

// ── Internals ─────────────────────────────────────────────────────────────────

/**
 * Have prospector store what was asked, and answer with what it said: its
 * status and its body, as they are. `502` where it does not answer at all.
 */
const stored = async (res: Response, method: string, path: string, body?: unknown): Promise<void> => {
  try {
    const answer = await send(method, path, body);

    if (answer.body === null) res.status(answer.status).end();
    else res.status(answer.status).json(answer.body);
  } catch (err) {
    logger.warn({ err }, 'Prospector did not store a lens');

    res.status(502).json({ error: 'The collector is not answering; try again shortly' });
  }
};

const definitionOf = (req: Request): LensDefinition => {
  const body = (req.body ?? {}) as LensDefinition & { definition?: LensDefinition };

  const had = body.definition ?? body;

  return { format: had.format ?? 1, venues: had.venues ?? {} };
};

