import { XMLBuilder } from 'fast-xml-parser';
import type { DatabaseSync } from 'node:sqlite';
import type { ListingFile, ListingPage, ListingRequest, S3Body, VenueRow } from '../types';

/**
 * A venue's listing in S3's own shape.
 *
 * **`ListObjects` V1 by default** — resume after `marker` — and V2's shape when
 * asked with `list-type=2`: `continuation-token` or `start-after` in, `KeyCount`
 * and `NextContinuationToken` out. Both resume after an exact key, so they are
 * one listing with two spellings. Not implemented, until something needs them:
 * `prefix`, `delimiter`, `encoding-type`, `fetch-owner`.
 *
 * **Each object also carries a `FileId`**, which S3 does not: the catalog's own
 * number for the file, and what a report names it by.
 *
 * **`BaseUrl` and `Url` join into the address**: where every object of a page
 * lives under one base, `BaseUrl` is it and each `Url` the rest; where a page
 * mixes a venue's hosts, `BaseUrl` is empty and each `Url` is whole.
 */

/** `max-keys` is 500 unless asked, 1,000 at most. */
export const MAX_KEYS = 1_000;

/** What a listing request asks for, or why it cannot be answered. */
export const requestOf = (query: Record<string, unknown>): ListingRequest | string => {
  const maxKeys = keysAsked(query['max-keys']);

  if (maxKeys === null) return `max-keys must be a whole number from 1 to ${MAX_KEYS}`;

  const v2    = text(query['list-type']) === '2';
  const token = text(query['continuation-token']);
  const start = text(query['start-after']);

  return {
    v2, maxKeys,
    ...(token === undefined ? {} : { token }),
    ...(start === undefined ? {} : { start }),
    after:   (v2 ? token ?? start : text(query['marker'])) ?? null,
    pending: ['true', '1'].includes(text(query['pending']) ?? ''),
  };
};

/** One page as S3's `ListBucketResult`, V1 or V2 as asked. */
export const resultOf = (db: DatabaseSync, venue: string, ids: readonly number[], asked: ListingRequest, page: ListingPage): S3Body => {
  const bases = basesOf(db, ids);
  const held  = [...new Set(page.objects.map(one => one.file.venueId))];
  const base  = held.length === 1 ? bases.get(held[0]!)! : '';
  const last  = page.objects[page.objects.length - 1]?.key;

  const contents = page.objects.map(({ key, file }) => ({
    Key:    key,
    FileId: file.id,
    Url:    base ? file.path : `${bases.get(file.venueId) ?? ''}${file.path}`,
    ...described(file),
  }));

  return asked.v2
    ? {
      Name:        venue,
      Prefix:      '',
      MaxKeys:     asked.maxKeys,
      KeyCount:    contents.length,
      IsTruncated: page.truncated,
      ...(asked.token === undefined ? {} : { ContinuationToken: asked.token }),
      ...(asked.start === undefined ? {} : { StartAfter: asked.start }),
      ...(page.truncated && last ? { NextContinuationToken: last } : {}),
      BaseUrl:     base,
      Contents:    contents,
    }
    : {
      Name:        venue,
      Prefix:      '',
      Marker:      asked.after ?? '',
      MaxKeys:     asked.maxKeys,
      IsTruncated: page.truncated,
      ...(page.truncated && last ? { NextMarker: last } : {}),
      BaseUrl:     base,
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

const XMLNS = 'http://s3.amazonaws.com/doc/2006-03-01/';

const xml = new XMLBuilder({ ignoreAttributes: false, format: true });

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
    const row = read.get(id) as Pick<VenueRow, 'base' | 'keyRoot'> | undefined;

    return [id, row ? `${row.base.replace(/\/$/, '')}/${row.keyRoot}` : ''];
  }));
};

/** What S3 says about an object beyond its key, where the catalog knows it. */
const described = (file: ListingFile): Record<string, string | number> => ({
  ...(file.etag === null ? {} : { ETag: `"${file.etag}"` }),
  ...(file.size === null ? {} : { Size: file.size }),
  ...(file.modified === null ? {} : { LastModified: file.modified }),
});

const text = (raw: unknown): string | undefined =>
  (typeof raw === 'string' && raw !== '' ? raw : undefined);
