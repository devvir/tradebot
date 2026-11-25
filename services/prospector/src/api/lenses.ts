import { dropLens, editLens, lensNamed, putLens } from '@tradebot/lenses';
import { lensesChanged } from '../lenses';
import type { Application } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import type { LensWrite } from '@tradebot/lenses';

/**
 * Storing a lens: making one, replacing one, removing one.
 *
 * **Here because it is a write**, and this service is the only writer of the
 * catalog database. Checking and describing a lens is not this API's: beyond
 * the slug it is addressed by, a lens is stored as it is sent, and what is
 * answered is what the store says.
 *
 * **A write answers as soon as the lens is stored.** What its rules let through
 * is worked out afterwards, in the background (`lensesChanged`), and the lens
 * is answered `updating` until that is done.
 *
 * **A slug already in use is the only refusal a write answers itself** (`409`).
 * A write that fails for any other reason throws out of the route, and is
 * answered `500` by the API's error handler (`onError`).
 *
 * **The row is written where the request is handled, not in the queue the
 * survey's writes wait in.** Every write in this service is synchronous from its
 * `BEGIN` to its `COMMIT`, so nothing is ever half way through one when a
 * handler runs — and the queue can be seconds deep while a venue is walked,
 * which is no time to keep somebody waiting to be told a lens was saved. The
 * working out that follows does not wait in it either (`lensesChanged`).
 */
export const mountLenses = (app: Application, db: DatabaseSync): void => {
  app.post('/lenses', (req, res) => {
    const { slug, name, note, definition } = (req.body ?? {}) as LensWrite;

    if (! slug) {
      res.status(400).json({ error: 'A lens needs the slug it is addressed by' });

      return;
    }

    const lens = putLens(db, slug, name ?? '', note ?? '', definition);

    if (! lens) {
      res.status(409).json({ error: `A lens addressed as '${slug}' already exists` });

      return;
    }

    lensesChanged();

    res.status(201).json(lens);
  });

  /** Replace a lens, whole — its slug, its name, its note, its definition, or all of them. */
  app.put('/lenses/:slug', (req, res) => {
    const slug  = String(req.params['slug']);
    const saved = editLens(db, slug, (req.body ?? {}) as LensWrite);

    if (! saved) {
      const there = lensNamed(db, slug) !== null;

      res.status(there ? 409 : 404).json({ error: there ? 'That address is taken' : 'No such lens' });

      return;
    }

    lensesChanged();

    res.json(saved);
  });

  app.delete('/lenses/:slug', (req, res) => {
    if (! dropLens(db, String(req.params['slug']))) {
      res.status(404).json({ error: 'No such lens' });

      return;
    }

    res.status(204).end();
  });
};
