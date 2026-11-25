import type { CatalogFile, Existence, FileMetadata as Metadata, FileRow as Row, FileState } from '../types';

/**
 * A catalogued file's row: the columns it is read by, the trail its replaced
 * versions go to, and the rules for whether a sighting says anything the row
 * does not.
 */

/** The columns a catalogued file is compared on — see `Row`. */
export const ROW = `series_id AS seriesId, partition_id AS partitionId, date, size, etag, modified, existence,
             downloaded_at AS downloadedAt`;

/** The row catalogued at one path. */
export const CURRENT = `SELECT ${ROW} FROM file WHERE venue_id = ? AND path = ?`;

/**
 * Append the version a file is leaving behind to its trail, keyed by when its
 * replacement was observed. Writing the same replacement twice says nothing new.
 */
export const REVISE = `INSERT INTO revision (venue_id, path, seen_at, size, etag, modified, downloaded_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?)
                  ON CONFLICT (venue_id, path, seen_at) DO NOTHING`;

/**
 * Whether a sighting says nothing the row does not already say.
 *
 * The same silence rule as `restated`: a field the listing left unsaid is not a
 * field that changed.
 */
export const unchanged = (file: CatalogFile, was: Row): boolean =>
  ! restated(file, was)
  && file.date === was.date
  && file.existence === was.existence
  && file.seriesId === was.seriesId;

/**
 * Whether a finding is complete enough to be catalogued.
 *
 * **Size and checksum, because those are what the catalog promises.** `bytes` is
 * a real total only if every row has a size, and a downloader can check what it
 * received only against a checksum — a row missing either would make one of
 * those a lie for as long as it sat there.
 *
 * A venue that published sizes and no checksums would sit in `wip` for ever
 * waiting for something that is never coming. None does today: the listing
 * venues state all three with every key, and the one index venue states none.
 * If one appears, this is the line to revisit rather than the place to special
 * case it.
 */
export const ready = (seen: Metadata): boolean => seen.size !== null && seen.etag !== null;

/**
 * What a row counts as in its partition.
 *
 * The month is the date's first six characters — the one interpretation the
 * catalog makes of a stored value, and one it already makes elsewhere.
 */
export const stateOf = (
  partitionId:  number,
  existence:    Existence,
  size:         number | null,
  etag:         string | null,
  downloadedAt: string | null,
): FileState => ({
  partitionId,
  confirmed:  existence === 'confirmed',
  downloaded: downloadedAt !== null,
  bytes:      size ?? 0,
  etag,
});

/**
 * Whether a sighting states **different bytes** from the ones known: another
 * size, or another ETag.
 *
 * **A new `modified` alone is not that.** A venue republishing the same bytes
 * has changed nothing a consumer holds, so the file is not owed again and
 * nothing is added to its trail — the new time is simply what the row says.
 */
export const replaced = (seen: Metadata, was: Metadata): boolean =>
  (seen.size !== null && seen.size !== was.size)
  || (seen.etag !== null && ! sameTag(seen.etag, was.etag));

/**
 * Whether a sighting **states** something that differs from what is known.
 *
 * The distinction the whole trail rests on: a field left unsaid is not a field
 * that changed. A walk of an HTML index says nothing about size or checksum, and
 * treating that silence as "now null" would put every file in `revision` on
 * every refresh — turning "what changed since I last looked" into "everything".
 */
const restated = (seen: Metadata, was: Metadata): boolean =>
  replaced(seen, was)
  || (seen.modified !== null && seen.modified !== was.modified);

/**
 * **The case of an ETag belongs to the server, not to the file.** Sightings are
 * normalised on the way in, so this only matters for rows stored before that
 * was true — but getting it wrong here is expensive rather than untidy: a
 * spurious difference appends a revision and clears `downloaded_at`, turning a
 * file already on disk back into one that is owed.
 */
const sameTag = (seen: string | null, was: string | null): boolean =>
  seen?.toLowerCase() === was?.toLowerCase();
