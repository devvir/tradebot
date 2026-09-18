import { XMLBuilder } from 'fast-xml-parser';
import { bucketPage, fileById } from '../catalog/bucket';
import { lensScope } from '../catalog/scope';
import { etagOf } from '../etag';
import { venueIds } from '../catalog';
import { idsFor, MAX_LIMIT, settleReport } from './routes';
import type { Application, Request, Response } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import type { BucketFile, BucketReported, LensScope } from '../types';

/**
 * Each venue as a storage bucket: a listing in S3's own shape, and a report of
 * what became of it.
 *
 * **S3's listing, as far as a downloader needs it.** `ListObjects` V1 by default
 * — resume after `marker` — and V2's shape when asked with `list-type=2`:
 * `continuation-token` or `start-after` in, `KeyCount` and
 * `NextContinuationToken` out. Both resume after an exact key, so they are one
 * listing with two spellings. `max-keys` is 500 unless asked, 1,000 at most.
 * Not implemented, until something needs them: `prefix`, `delimiter`,
 * `encoding-type`, `fetch-owner`.
 *
 * **XML, as S3 answers, unless JSON is asked for** with `Accept:
 * application/json` — the same fields under the same names either way, errors
 * included, which take S3's `Error` shape of `Code` and `Message`. An ETag keeps
 * S3's quotes as part of its value, so JSON shows them escaped.
 *
 * **Two filters S3 does not have.** A lens, named in `x-catalog-lens` — absent
 * is every file, an unknown name is a `404` rather than everything — and
 * `pending=true`, which lists only files not yet downloaded. Either one simply
 * leaves files out, as though the bucket did not hold them.
 *
 * **Each object also carries a `FileId`**, which S3 does not: the catalog's own
 * number for the file, and what a report names it by. A key is S3's identity
 * and stays the listing's cursor; anything else speaks in ids.
 *
 * **`BaseUrl` and `Url` join into the address**, whatever the page holds: where
 * every object of a page lives under one base, `BaseUrl` is it and each `Url`
 * the rest; where a page mixes a venue's hosts, `BaseUrl` is empty and each
 * `Url` is whole.
 */
export const mountBucket = (app: Application, db: DatabaseSync): void => {
  app.get('/buckets/:venue', (req, res) => {
    const venue = String(req.params['venue']);
    const ids   = venueIds(db, venue);

    if (ids.length === 0) return failed(req, res, 404, 'NoSuchBucket', 'The specified bucket does not exist');

    const scope = scopeFrom(db, req, res);

    if (scope === false) return;

    const maxKeys = keysAsked(req.query['max-keys']);

    if (maxKeys === null)
      return failed(req, res, 400, 'InvalidArgument', `max-keys must be a whole number from 1 to ${MAX_KEYS}`);

    const v2    = text(req.query['list-type']) === '2';
    const token = text(req.query['continuation-token']);
    const start = text(req.query['start-after']);
    const after = (v2 ? token ?? start : text(req.query['marker'])) ?? null;

    const page = bucketPage(db, venue, ids, {
      after,
      maxKeys,
      pending: ['true', '1'].includes(text(req.query['pending']) ?? ''),
      scope:   scope ? scope.get(venue) ?? new Map() : null,
    });

    const bases = basesOf(db, ids);
    const held  = [...new Set(page.objects.map(one => one.file.venueId))];
    const base  = held.length === 1 ? bases.get(held[0]!)! : '';
    const last  = page.objects[page.objects.length - 1]?.key;

    const contents = page.objects.map(({ key, file }) => ({
      Key:    key,
      FileId: file.id,
      Url: base ? file.path : `${bases.get(file.venueId) ?? ''}${file.path}`,
      ...described(file),
    }));

    answer(req, res, 200, 'ListBucketResult', v2
      ? {
        Name:     venue,
        Prefix:   '',
        MaxKeys:  maxKeys,
        KeyCount: contents.length,
        IsTruncated: page.truncated,
        ...(token === undefined ? {} : { ContinuationToken: token }),
        ...(start === undefined ? {} : { StartAfter: start }),
        ...(page.truncated && last ? { NextContinuationToken: last } : {}),
        BaseUrl:  base,
        Contents: contents,
      }
      : {
        Name:        venue,
        Prefix:      '',
        Marker:      after ?? '',
        MaxKeys:     maxKeys,
        IsTruncated: page.truncated,
        ...(page.truncated && last ? { NextMarker: last } : {}),
        BaseUrl:     base,
        Contents:    contents,
      });
  });

  /**
   * What became of a page, by `FileId`. The same report as
   * `POST /venues/:venue/report`, settled the same way — see `settleReport`. An
   * id that names no file of this venue is counted in `unknown` and otherwise
   * ignored.
   */
  app.post('/buckets/:venue/report', async (req, res) => {
    const ids = idsFor(db, req, res);

    if (! ids) return;

    const body = (req.body ?? {}) as Partial<BucketReported>;

    const downloaded = Array.isArray(body.downloaded) ? body.downloaded : [];
    const failed     = Array.isArray(body.failed) ? body.failed : [];
    const mismatched = Array.isArray(body.mismatched) ? body.mismatched : [];

    if (downloaded.length + failed.length + mismatched.length > MAX_LIMIT) {
      res.status(400).json({ error: `At most ${MAX_LIMIT} files per report` });

      return;
    }

    let unknown = 0;

    const find = (id: unknown): BucketFile | null => {
      const file = typeof id === 'number' ? fileById(db, ids, id) : null;

      if (! file) unknown++;

      return file;
    };

    const known = <T>(one: T | null): one is T => one !== null;

    const settled = await settleReport(db, {
      downloaded: downloaded.map(find).filter(known),
      failed:     failed.map(find).filter(known),
      mismatched: mismatched
        .map(one => {
          const file = find(one?.FileId);

          return file
            ? { file, claimed: {
              ...(one.Size === undefined ? {} : { size: one.Size }),
              ...(one.ETag === undefined ? {} : { etag: etagOf(one.ETag) }),
            } }
            : null;
        })
        .filter(known),
    });

    res.json({ ...settled, unknown });
  });
};

// ── Internals ─────────────────────────────────────────────────────────────────

const MAX_KEYS     = 1_000;
const DEFAULT_KEYS = 500;

const XMLNS = 'http://s3.amazonaws.com/doc/2006-03-01/';

const xml = new XMLBuilder({ ignoreAttributes: false, format: true });

/** A body under its S3 element name: XML unless the request prefers JSON, where the name is left off. */
const answer = (req: Request, res: Response, status: number, root: string, body: object): void => {
  if (req.accepts(['xml', 'json']) === 'json') {
    res.status(status).json(body);

    return;
  }

  res.status(status).type('application/xml').send(xml.build({
    '?xml': { '@_version': '1.0', '@_encoding': 'UTF-8' },
    [root]: root === 'ListBucketResult' ? { '@_xmlns': XMLNS, ...body } : body,
  }));
};

/** An error in S3's shape. */
const failed = (req: Request, res: Response, status: number, code: string, message: string): void =>
  answer(req, res, status, 'Error', { Code: code, Message: message });

/** The lens a request names, null where it names none, false where it named an unknown one and was answered. */
const scopeFrom = (db: DatabaseSync, req: Request, res: Response): LensScope | null | false => {
  const slug = req.headers['x-catalog-lens'];

  if (typeof slug !== 'string' || slug.trim() === '') return null;

  const scope = lensScope(db, slug.trim());

  if (! scope) {
    failed(req, res, 404, 'NoSuchLens', `No such lens: ${slug.trim()}`);

    return false;
  }

  return scope;
};

/** `max-keys` as asked: 500 where absent, capped at 1,000, null where it is not a count. */
const keysAsked = (raw: unknown): number | null => {
  const given = text(raw);

  if (given === undefined) return DEFAULT_KEYS;

  const count = Number(given);

  if (! Number.isInteger(count) || count < 1) return null;

  return Math.min(count, MAX_KEYS);
};

/** Each host's address up to the key, so a path below the key root completes it. */
const basesOf = (db: DatabaseSync, ids: readonly number[]): Map<number, string> => {
  const read = db.prepare('SELECT base, key_root AS keyRoot FROM venue WHERE id = ?');

  return new Map(ids.map(id => {
    const row = read.get(id) as { base: string; keyRoot: string } | undefined;

    return [id, row ? `${row.base.replace(/\/$/, '')}/${row.keyRoot}` : ''];
  }));
};

/** What S3 says about an object beyond its key, where the catalog knows it. */
const described = (file: BucketFile): Record<string, string | number> => ({
  ...(file.etag === null ? {} : { ETag: `"${file.etag}"` }),
  ...(file.size === null ? {} : { Size: file.size }),
  ...(file.modified === null ? {} : { LastModified: file.modified }),
});

const text = (raw: unknown): string | undefined =>
  (typeof raw === 'string' && raw !== '' ? raw : undefined);
