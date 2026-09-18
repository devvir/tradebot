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
