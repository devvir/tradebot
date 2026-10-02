import {
  dropLens, editLens, lensInstruments, lensNameIsSound, lensNamed, lensOptions, lensSize, lenses,
  problemsWith, putLens, resolvedSummary,
} from '../lenses/lens';
import type { Application, Request } from 'express';
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
 * Applying a lens to the rest of the API is a separate thing and lives elsewhere:
 * these endpoints are how one is defined, not how one is used.
 */
export const mountLenses = (app: Application, db: DatabaseSync): void => {
  app.get('/lenses', (_req, res) => {
    res.json({ items: lenses(db) });
  });

  app.get('/lenses/:slug', (req, res) => {
    const found = lensNamed(db, String(req.params['slug']));

    if (! found) {
      res.status(404).json({ error: 'No such lens' });

      return;
    }

    res.json(found);
  });

  /**
   * **What a venue publishes**, so an editor offers only combinations that exist
   * rather than every string the catalog has ever seen.
   */
  app.get('/lenses/options/:venue', (req, res) => {
    res.json({ items: lensOptions(db, String(req.params['venue'])) });
  });

  /**
   * **The instruments a rule may name.** Its own endpoint rather than the
   * contents one, because a lens can be written about every venue at once and
   * `*` is not a venue anything else knows about.
   */
  app.get('/lenses/instruments/:venue', (req, res) => {
    res.json({ items: lensInstruments(db, String(req.params['venue'])) });
  });

  app.post('/lenses', (req, res) => {
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

    const lens = putLens(db, slug, name ?? '', note ?? '', definition);

    if (! lens) {
      res.status(409).json({ error: `A lens addressed as '${slug}' already exists` });

      return;
    }

    res.status(201).json(lens);
  });

  /** Replace a lens, whole — its name, its note, its definition, or all three. */
  app.put('/lenses/:slug', (req, res) => {
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

    const saved = editLens(db, slug, to);

    if (! saved) {
      res.status(lensNamed(db, slug) ? 409 : 404)
        .json({ error: lensNamed(db, slug) ? 'That address is taken' : 'No such lens' });

      return;
    }

    res.json(saved);
  });

  app.delete('/lenses/:slug', (req, res) => {
    if (! dropLens(db, String(req.params['slug']))) {
      res.status(404).json({ error: 'No such lens' });

      return;
    }

    res.status(204).end();
  });

  /**
   * **What a definition would cost, before it is stored.** The editor asks on
   * every change, so this takes the document in the body rather than reading a
   * saved one.
   */
  app.post('/lenses/size', (req, res) => {
    res.json(lensSize(db, definitionOf(req)));
  });

  /** The same, for a lens that exists. */
  app.get('/lenses/:slug/size', (req, res) => {
    const found = lensNamed(db, String(req.params['slug']));

    if (! found) {
      res.status(404).json({ error: 'No such lens' });

      return;
    }

    res.json(lensSize(db, found.definition));
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

const definitionOf = (req: Request): LensDefinition => {
  const body = (req.body ?? {}) as LensDefinition & { definition?: LensDefinition };

  const had = body.definition ?? body;

  return { format: had.format ?? 1, venues: had.venues ?? {} };
};

