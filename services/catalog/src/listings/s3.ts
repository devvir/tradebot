import { XMLBuilder } from 'fast-xml-parser';
import { INVALID, flag, queryText, xmlCarries } from '../api/query';
import type { DatabaseSync } from 'node:sqlite';
import type { ListingFile, ListingPage, ListingRefusal, ListingRequest, S3Body } from '../types';

/**
 * The catalog's listing in S3's own shape: one bucket, every venue's files.
 *
 * **`ListObjects` V1 by default** — resume after `marker` — and V2's shape when
 * asked with `list-type=2`: `continuation-token` or `start-after` in, `KeyCount`
 * and `NextContinuationToken` out. Both resume after an exact key, so they are
 * one listing with two spellings. **`prefix` narrows it**, a venue (`gate/`) or
 * anything finer.
 *
 * **Keys are listed flat.** A `delimiter` is answered `501 NotImplemented`, so
 * a client that groups by one never takes a flat page for a grouped one.
 * `encoding-type` and `fetch-owner` are ignored: keys are sent as they are,
 * with no `EncodingType`, and no object names an owner.
 *
 * **Each object's `Path` is the file's own, below its server's address**, and
 * `Host` names the server where the venue has more than one. A server can be
 * reached at several addresses — `/venues` lists them — so the listing names
 * none: which one a file is fetched from is the fetcher's choice.
 */

/** The bucket's name, as S3 answers it. */
export const BUCKET = 'catalog';

/** `max-keys` is 500 unless asked, 1,000 at most. */
export const MAX_KEYS = 1_000;

/**
 * What a listing request asks for, or why it cannot be answered: `400
 * InvalidArgument` for a parameter given more than once, one the answer would
 * echo holding a character XML cannot carry, or a value that is not one of the
 * parameter's; `501 NotImplemented` for a `delimiter`.
 */
export const requestOf = (query: Record<string, unknown>): ListingRequest | ListingRefusal => {
  const given: Partial<Record<Parameter, string>> = {};

  for (const name of PARAMETERS) {
    const one = queryText(query[name]);

    if (one === INVALID) return invalid(`${name} may be given once`);
    if (one !== undefined) given[name] = one;
  }

  if (given.delimiter !== undefined)
    return { status: 501, code: 'NotImplemented', message: 'delimiter is not supported; keys are listed flat' };

  const unfit = ECHOED.find(name => given[name] !== undefined && ! xmlCarries(given[name]));

  if (unfit) return invalid(`${unfit} holds a character XML cannot carry`);

  const maxKeys = keysAsked(given['max-keys']);

  if (maxKeys === null) return invalid(`max-keys must be a whole number from 1 to ${MAX_KEYS}`);

  const listType = given['list-type'];

  if (listType !== undefined && listType !== '1' && listType !== '2') return invalid('list-type must be 1 or 2');

  const pending = flag(query['pending']);

  if (pending === 'invalid') return invalid('pending must be true or false');

  const v2    = listType === '2';
  const token = given['continuation-token'];
  const start = given['start-after'];

  return {
    v2, maxKeys,
    ...(token === undefined ? {} : { token }),
    ...(start === undefined ? {} : { start }),
    after:   (v2 ? token ?? start : given.marker) ?? null,
    prefix:  given.prefix ?? '',
    pending: pending === true,
    ...(given.partition === undefined ? {} : { partition: given.partition }),
  };
};

/** One page as S3's `ListBucketResult`, V1 or V2 as asked. */
export const resultOf = (db: DatabaseSync, asked: ListingRequest, page: ListingPage): S3Body => {
  const hosts = hostNamesOf(db);
  const last  = page.objects[page.objects.length - 1]?.key;

  const contents = page.objects.map(({ key, file }) => ({
    Key: key,
    Path: file.path,
    Host: hosts.get(file.venueId) ?? '',
    ...described(file),
  }));

  return asked.v2
    ? {
      Name:        BUCKET,
      Prefix:      asked.prefix,
      MaxKeys:     asked.maxKeys,
      KeyCount:    contents.length,
      IsTruncated: page.truncated,
      ...(asked.token === undefined ? {} : { ContinuationToken: asked.token }),
      ...(asked.start === undefined ? {} : { StartAfter: asked.start }),
      ...(page.truncated && last ? { NextContinuationToken: last } : {}),
      Contents:    contents,
    }
    : {
      Name:        BUCKET,
      Prefix:      asked.prefix,
      Marker:      asked.after ?? '',
      MaxKeys:     asked.maxKeys,
      IsTruncated: page.truncated,
      ...(page.truncated && last ? { NextMarker: last } : {}),
      Contents:    contents,
    };
};

/**
 * A body as S3 would send it: XML under its element name, unless JSON was asked
 * for with `Accept: application/json` — the same fields under the same names.
 * An ETag keeps S3's quotes as part of its value, so JSON shows them escaped.
 */
export const asXml = (root: string, body: S3Body): string => xml.build({
  '?xml': { '@_version': '1.0', '@_encoding': 'UTF-8' },
  [root]: root === 'ListBucketResult' ? { '@_xmlns': XMLNS, ...body } : body,
});

// ── Internals ─────────────────────────────────────────────────────────────────

const DEFAULT_KEYS = 500;

/** The parameters a listing reads, each given once or not at all. */
const PARAMETERS = [
  'prefix', 'marker', 'continuation-token', 'start-after', 'max-keys', 'list-type', 'pending', 'partition', 'delimiter',
] as const;

type Parameter = typeof PARAMETERS[number];

/** The parameters an answer echoes, in its fields or in its error's message. */
const ECHOED = ['prefix', 'marker', 'continuation-token', 'start-after', 'partition'] as const;

const invalid = (message: string): ListingRefusal => ({ status: 400, code: 'InvalidArgument', message });

const XMLNS = 'http://s3.amazonaws.com/doc/2006-03-01/';

const xml = new XMLBuilder({ ignoreAttributes: false, format: true });

/** `max-keys` as asked: 500 where absent, capped at 1,000, null where it is not a count. */
const keysAsked = (given: string | undefined): number | null => {
  if (given === undefined) return DEFAULT_KEYS;

  const count = Number(given);

  if (! Number.isInteger(count) || count < 1) return null;

  return Math.min(count, MAX_KEYS);
};

/** Each server's name within its venue: `''` where the venue has one. */
const hostNamesOf = (db: DatabaseSync): Map<number, string> =>
  new Map((db.prepare('SELECT id, host FROM venue').all() as unknown as { id: number; host: string }[])
    .map(row => [row.id, row.host]));

/** What S3 says about an object beyond its key, where the catalog knows it. */
const described = (file: ListingFile): Record<string, string | number> => ({
  ...(file.etag === null ? {} : { ETag: `"${file.etag}"` }),
  ...(file.size === null ? {} : { Size: file.size }),
  ...(file.modified === null ? {} : { LastModified: file.modified }),
});
