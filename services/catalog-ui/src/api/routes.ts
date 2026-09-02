import { logger } from '@devvir/service-kit';
import express from 'express';
import { join } from 'node:path';
import config from '../config';
import type { Application, Request, Response } from 'express';

/**
 * Two things: the page, and a way for it to reach the services behind it.
 *
 * **The browser never talks to the catalog directly**, and the reason is where
 * the catalog is allowed to be. Prospector is meant to run wherever the link to
 * the venues is good — another machine, another network — which is the whole
 * point of it being an HTTP service rather than a library. A page calling it
 * directly works only while it happens to be reachable from whichever browser is
 * open, and stops the day it moves.
 *
 * **And the token would have to travel with the browser.** Where one is set, a
 * page calling the catalog itself has to carry it, which means shipping the
 * secret in the bundle and sending it from wherever the page is open. Here it
 * stays on the server and the page never sees it.
 *
 * CORS is a consequence of that arrangement rather than a reason for it: the
 * catalog sends no such headers today, so a browser could not call it across
 * origins anyway — but that could be changed, and it is not what decides this.
 */

/** Where `vite build` leaves the page, relative to `dist/src/api/`. */
const PAGE = join(__dirname, '..', '..', 'web');

export const setupRoutes = (app: Application): void => {
  app.use('/api/catalog', forward(() => config.catalogUrl, config.catalogToken));

  /**
   * **Absent rather than broken where there is no hauler.** A deployment
   * surveying on one machine and hauling on another may not be able to reach
   * one, and a proxy to nowhere answers with a timeout that reads as a bug.
   */
  app.use('/api/hauler', config.haulerUrl
    ? forward(() => config.haulerUrl, config.catalogToken)
    : (_req: Request, res: Response) =>
      res.status(503).json({ error: 'No hauler is configured — set HAULER_URL' }));

  /** What this page needs to know about itself, so nothing is baked into it. */
  app.get('/api/where', (_req, res) => {
    res.json({ catalog: config.catalogUrl, hauler: config.haulerUrl || null });
  });

  app.use(express.static(PAGE));
};

// ── Internals ─────────────────────────────────────────────────────────────────

/**
 * Pass a request upstream and hand the answer back unchanged.
 *
 * **Unchanged is the whole contract.** This service adds the token and nothing
 * else — no reshaping, no defaults, no interpretation — so what the page shows
 * is what the API said. Anything else would make this a second opinion about
 * the catalog, and a UI that quietly improves its answers is a UI that hides the
 * thing it was built to reveal.
 */
const forward = (upstream: () => string, token: string) =>
  async (req: Request, res: Response): Promise<void> => {
    const url = `${upstream()}${req.url}`;

    try {
      const answer = await fetch(url, {
        method:  req.method,
        headers: {
          ...(token ? { 'x-catalog-token': token } : {}),
          'content-type': 'application/json',
        },
        ...(req.method === 'GET' || req.method === 'HEAD'
          ? {}
          : { body: JSON.stringify(req.body ?? {}) }),
      });

      res.status(answer.status).type('application/json').send(await answer.text());
    } catch (err) {
      logger.warn({ err, url }, 'Could not reach the service behind the UI');

      res.status(502).json({ error: `Could not reach ${url}` });
    }
  };
