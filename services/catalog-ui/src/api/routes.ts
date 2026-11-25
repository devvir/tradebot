import { logger } from '@devvir/service-kit';
import express from 'express';
import { join } from 'node:path';
import config from '../config';
import type { Config } from '../types';
import type { Application, NextFunction, Request, Response } from 'express';

/**
 * The page, and the requests it makes of the catalog and of prospector,
 * forwarded with the token added — so the token stays on this server.
 *
 * Only the requests listed in `CATALOG` and `PROSPECTOR` are forwarded; any
 * other method or path under `/api/catalog` or `/api/prospector` answers `404`
 * without leaving this process. `sameSite` runs ahead of both. The contract the
 * page relies on is described in docs/services/CATALOG-UI.md.
 */

/** What routing needs from the configuration. */
export type Upstreams = Pick<Config,
  'catalogApi' | 'prospectorApi' | 'catalogToken' | 'allowedHosts' | 'upstreamTimeoutMs'>;

/** Where `vite build` leaves the page, relative to `dist/src/api/`. */
const PAGE = join(__dirname, '..', '..', 'web');

export const setupRoutes = (app: Application, using: Upstreams = config): void => {
  app.use(['/api/catalog', '/api/prospector'], sameSite(using.allowedHosts));
  app.use('/api/catalog', forward('the catalog', using.catalogApi, CATALOG, using));
  app.use('/api/prospector', forward('prospector', using.prospectorApi, PROSPECTOR, using));

  /** What this page needs to know about itself, so nothing is baked into it. */
  app.get('/api/where', (_req, res) => {
    res.json({ catalog: using.catalogApi });
  });

  app.use(express.static(PAGE));
};

// ── Internals ─────────────────────────────────────────────────────────────────

/** A request that is forwarded: its method, and its path below the mount. `GET` also admits `HEAD`. */
type Allowed = readonly [method: string, path: RegExp];

/** What the page asks of the catalog. A segment is anything but `/`, so `a%2Fb` is one. */
const CATALOG: readonly Allowed[] = [
  ['GET',    /^\/venues$/],
  ['GET',    /^\/venues\/[^/]+$/],
  ['GET',    /^\/venues\/[^/]+\/symbols$/],
  ['GET',    /^\/venues\/[^/]+\/markets\/[^/]+$/],
  ['GET',    /^\/venues\/[^/]+\/markets\/[^/]+\/symbols$/],
  ['GET',    /^\/lenses$/],
  ['GET',    /^\/lenses\/options$/],
  ['GET',    /^\/lenses\/[^/]+\/size$/],
  ['POST',   /^\/lenses$/],
  ['PUT',    /^\/lenses\/[^/]+$/],
  ['DELETE', /^\/lenses\/[^/]+$/],
];

/** What the page asks of prospector's collector. */
const PROSPECTOR: readonly Allowed[] = [
  ['GET',  /^\/status$/],
  ['POST', /^\/surveys$/],
  ['POST', /^\/surveys\/pause$/],
  ['POST', /^\/venues\/[^/]+\/surveys$/],
];

/** Methods a browser sends cross-origin only after a preflight, or that carry no body. */
const BODILESS_OR_PREFLIGHTED = new Set(['GET', 'HEAD', 'DELETE']);

/**
 * Refuse what another site, or another name, could make a browser send.
 *
 * - `403` where `Host` is not in `allowed` (when that list is not empty).
 * - `403` where `Sec-Fetch-Site` says the request came from another origin;
 *   `none` (typed into the address bar) is let through.
 * - `403` where `Origin` names a host other than `Host`.
 * - `415` for a write that is not `application/json`: a browser sends such a
 *   body cross-origin only after a preflight, which fails here because no CORS
 *   header is ever sent.
 */
const sameSite = (allowed: readonly string[]) =>
  (req: Request, res: Response, next: NextFunction): void => {
    const host = (req.headers.host ?? '').toLowerCase();

    if (allowed.length > 0 && ! allowed.includes(host) && ! allowed.includes(hostnameOf(host))) {
      res.status(403).json({ error: `Not served as ${host || 'no host'}` });

      return;
    }

    const site = req.headers['sec-fetch-site'];

    if (site !== undefined && site !== 'same-origin' && site !== 'none') {
      res.status(403).json({ error: 'Not forwarded for another site' });

      return;
    }

    const origin = req.headers.origin;

    if (origin !== undefined && originHostOf(origin) !== host) {
      res.status(403).json({ error: 'Not forwarded for another origin' });

      return;
    }

    if (! BODILESS_OR_PREFLIGHTED.has(req.method) && ! req.is('application/json')) {
      res.status(415).json({ error: 'A write must be application/json' });

      return;
    }

    next();
  };

/**
 * Pass an allowed request to `upstream` and relay its answer: the status, the
 * content type and the body bytes as they came.
 *
 * What goes upstream is the path and query, the token, `x-catalog-lens`,
 * `Accept` (`application/json` when the client sent none), and the parsed JSON
 * body where there is one, with its content type. Nothing else of the client's
 * request is passed on.
 *
 * A client that goes away aborts the upstream request; nothing is answered or
 * logged for it. A request with no answer within `upstreamTimeoutMs` answers
 * `504`, and one that cannot reach `upstream` answers `502`.
 */
const forward = (name: string, upstream: string, allowed: readonly Allowed[], using: Upstreams) =>
  async (req: Request, res: Response): Promise<void> => {
    const target = targetOf(upstream, allowed, req);

    if (target === null) {
      res.status(404).json({ error: 'Not forwarded' });

      return;
    }

    const gone = new AbortController();

    res.on('close', () => { if (! res.writableFinished) gone.abort(); });

    const body = req.body === undefined || req.method === 'GET' || req.method === 'HEAD'
      ? undefined
      : JSON.stringify(req.body);

    const lens = req.headers['x-catalog-lens'];

    try {
      const answer = await fetch(target, {
        method:   req.method,
        redirect: 'manual',
        headers:  {
          ...(using.catalogToken ? { 'x-catalog-token': using.catalogToken } : {}),
          ...(typeof lens === 'string' ? { 'x-catalog-lens': lens } : {}),
          accept: req.headers.accept ?? 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body }),
        signal: AbortSignal.any([gone.signal, AbortSignal.timeout(using.upstreamTimeoutMs)]),
      });

      const bytes = Buffer.from(await answer.arrayBuffer());

      if (gone.signal.aborted || res.headersSent) return;

      const type = answer.headers.get('content-type');

      res.status(answer.status);

      if (type) res.setHeader('content-type', type);

      res.send(bytes);
    } catch (err) {
      if (gone.signal.aborted || res.headersSent) return;

      if ((err as Error | undefined)?.name === 'TimeoutError') {
        logger.warn({ url: target.href }, `No answer from ${name}`);

        res.status(504).json({ error: `No answer from ${name} within ${using.upstreamTimeoutMs / 1000} s` });

        return;
      }

      logger.warn({ err, url: target.href }, `Could not reach ${name}`);

      res.status(502).json({ error: `Could not reach ${name}` });
    }
  };

/**
 * The upstream URL for `req`, or `null` where it is not forwarded.
 *
 * Built from the path below the mount and the query only — never from the
 * request target as sent, which may be absolute — and kept only where it
 * resolves to `upstream`'s origin with the path unchanged, so a dot segment
 * (`..`, `%2e%2e`) cannot step outside what `allowed` matched.
 */
const targetOf = (upstream: string, allowed: readonly Allowed[], req: Request): URL | null => {
  const method = req.method === 'HEAD' ? 'GET' : req.method;

  if (! allowed.some(([m, path]) => m === method && path.test(req.path))) return null;

  const base   = new URL(upstream);
  const prefix = base.pathname.replace(/\/$/, '');
  const at     = req.url.indexOf('?');
  const search = at === -1 ? '' : req.url.slice(at);

  let target: URL;

  try {
    target = new URL(`${prefix}${req.path}${search}`, base);
  } catch {
    return null;
  }

  return target.origin === base.origin && target.pathname === `${prefix}${req.path}` ? target : null;
};

/** `host` without its port. */
const hostnameOf = (host: string): string => host.replace(/:\d+$/, '');

/** The `host[:port]` an `Origin` names, or `null` where it names none (`null`, garbage). */
const originHostOf = (origin: string): string | null => {
  try {
    return new URL(origin).host.toLowerCase();
  } catch {
    return null;
  }
};
