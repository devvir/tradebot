/**
 * An ETag reduced to what actually identifies the object.
 *
 * **Lower-cased, because the case belongs to the server rather than to the
 * file.** OKX serves the same order-book file from two clouds under two
 * prefixes — byte-identical, same length, and the same md5 in opposite cases,
 * uppercase from Alibaba OSS and lowercase from S3. A comparison that keeps the
 * case reads that as a new version: it appends a revision and clears
 * `downloaded_at`, marking a file already on disk as owed again. Nothing about
 * a hex digest is case-bearing, so normalising cannot lose a distinction.
 *
 * Quotes go because every venue sends them and none means them, and Apache's
 * `-gzip` suffix goes because it describes the transfer rather than the entity.
 */
export const etagOf = (raw: string | null | undefined): string | null =>
  raw?.replace(/^&quot;|&quot;$/g, '')
    .replace(/^"|"$/g, '')
    .replace(/-gzip$/, '')
    .toLowerCase() ?? null;

/**
 * A `Content-Length` read as a size in bytes, or null where it states none.
 *
 * **A header that is not there is unknown, not zero.** `Number(null)` is 0 and
 * `Number('')` is 0, either of which would record an unanswered size as an empty
 * file; anything but a run of digits that fits a safe integer is no size at all.
 */
export const sizeOf = (raw: string | null | undefined): number | null => {
  if (raw === null || raw === undefined || ! /^\d+$/.test(raw.trim())) return null;

  const size = Number(raw.trim());

  return Number.isSafeInteger(size) ? size : null;
};

/** What a file's response headers say about it: what a `HEAD` on the file learns. */
export interface HeadMetadata {
  size:     number | null;
  etag:     string | null;
  /** `Last-Modified` exactly as sent. */
  modified: string | null;
}

/**
 * Size, ETag and last-modified off a response to the file itself, each reduced
 * the one way every reader of a `HEAD` reduces it — see `sizeOf` and `etagOf`.
 */
export const metadataOf = (headers: Headers): HeadMetadata => ({
  size:     sizeOf(headers.get('content-length')),
  etag:     etagOf(headers.get('etag')),
  modified: headers.get('last-modified'),
});
