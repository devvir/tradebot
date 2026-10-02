import { lensRequested } from '../lenses/requested';
import { listingPage } from '../listings/listing';
import { asXml, requestOf, resultOf } from '../listings/s3';
import { venueIds } from '../queries';
import type { Application, Request, Response } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import type { S3Body } from '../types';

/**
 * Each venue's files as an S3 listing — see `listings/s3.ts` for the shape.
 *
 * **Two filters S3 does not have.** A lens named in `x-catalog-lens`, and
 * `pending=true` for files not yet downloaded; either one simply leaves files
 * out, as though the listing did not hold them.
 */
export const mountListings = (app: Application, db: DatabaseSync): void => {
  app.get('/listings/:venue', (req, res) => {
    const venue = String(req.params['venue']);
    const ids   = venueIds(db, venue);

    if (ids.length === 0) return failed(req, res, 404, 'NoSuchBucket', 'The specified bucket does not exist');

    const lens = lensRequested(db, req);

    if (lens === undefined) return failed(req, res, 404, 'NoSuchLens', `No such lens: ${String(req.headers['x-catalog-lens']).trim()}`);

    const asked = requestOf(req.query);

    if (typeof asked === 'string') return failed(req, res, 400, 'InvalidArgument', asked);

    const page = listingPage(db, venue, ids, {
      after:   asked.after,
      maxKeys: asked.maxKeys,
      pending: asked.pending,
      scope:   lens ? lens.scope.get(venue) ?? new Map() : null,
    });

    answer(req, res, 200, 'ListBucketResult', resultOf(db, venue, ids, asked, page));
  });
};

// ── Internals ─────────────────────────────────────────────────────────────────

/** XML unless the request prefers JSON. */
const answer = (req: Request, res: Response, status: number, root: string, body: S3Body): void => {
  if (req.accepts(['xml', 'json']) === 'json') res.status(status).json(body);
  else res.status(status).type('application/xml').send(asXml(root, body));
};

/** An error in S3's shape: a `Code` and a `Message`. */
const failed = (req: Request, res: Response, status: number, code: string, message: string): void =>
  answer(req, res, status, 'Error', { Code: code, Message: message });
