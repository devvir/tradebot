import { lensOf, noSuchLens } from '../lenses/requested';
import { listingPage } from '../listings/listing';
import { inLens, partitionNamed } from '../listings/partition';
import { asXml, requestOf, resultOf } from '../listings/s3';
import type { Application, Request, Response } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import type { S3Body } from '../types';

/**
 * The catalog as one S3 bucket — see `listings/s3.ts` for the shape, and
 * `listings/listing.ts` for how a page is read.
 *
 * **Three filters S3 does not have.** A lens — see `lensSlug` —, `pending=true`
 * for files not yet downloaded, and `partition=<name>` for the files of one
 * partition; each simply leaves files out, as though the bucket did not hold
 * them.
 */
export const mountListings = (app: Application, db: DatabaseSync): void => {
  app.get('/listings', (req, res) => {
    const lens = lensOf(db, req);

    if (lens === undefined) return failed(req, res, 422, 'NoSuchLens', noSuchLens(req));

    const asked = requestOf(req.query);

    if ('code' in asked) return failed(req, res, asked.status, asked.code, asked.message);

    const partition = asked.partition === undefined ? null : partitionNamed(db, asked.partition);

    if (asked.partition !== undefined && ! partition)
      return failed(req, res, 422, 'NoSuchPartition', `No such partition: ${asked.partition}`);

    // Every key of a partition starts with its slice's: a prefix is narrowed to it, and one beside it holds none of its keys.
    const prefix = partition ? within(asked.prefix, partition.prefix) : asked.prefix;

    // A partition the lens does not let through is not in the bucket, as far as this request goes.
    const lensId = lens?.id;
    const hidden = partition !== null && lensId !== undefined && ! inLens(db, lensId, partition.id);

    const page = hidden || prefix === null ? { objects: [], truncated: false } : listingPage(db, {
      after:   asked.after,
      prefix,
      maxKeys: asked.maxKeys,
      pending: asked.pending,
      lens:    lens,
      partition: partition?.id ?? null,
    });

    answer(req, res, 200, 'ListBucketResult', resultOf(db, asked, page));
  });
};

/** XML unless the request prefers JSON. */
export const answer = (req: Request, res: Response, status: number, root: string, body: S3Body): void => {
  if (req.accepts(['xml', 'json']) === 'json') res.status(status).json(body);
  else res.status(status).type('application/xml').send(asXml(root, body));
};

/** An error in S3's shape: a `Code` and a `Message`. */
export const failed = (req: Request, res: Response, status: number, code: string, message: string): void =>
  answer(req, res, status, 'Error', { Code: code, Message: message });

// ── Internals ─────────────────────────────────────────────────────────────────

/** The narrower of two prefixes, where one starts with the other; null where no key can start with both. */
const within = (one: string, other: string): string | null =>
  one.startsWith(other) ? one : other.startsWith(one) ? other : null;
