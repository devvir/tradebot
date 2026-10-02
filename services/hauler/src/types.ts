/**
 * Everything hauler names, fetches and reports, in one place.
 *
 * **Hauler reads a bucket.** The catalog serves each venue as a storage bucket
 * keyed by what a file *is* — the canonical archive path — so hauler writes
 * each object at its key and needs no vocabulary of its own. See the catalog
 * API's bucket listing.
 */

/** What this deployment fetches, and from where. */
export type Config = {
  /** Where the archives are written, inside the container. */
  archivesDir:  string;

  catalogUrl:   string;

  /** Sent to the catalog on every request. Empty sends none. */
  catalogToken: string;

  /** The venues to haul; empty for every venue the catalog knows. */
  venues:       string[];

  /**
   * The catalog lens to haul through, sent as `x-catalog-lens`; empty for
   * every file the catalog holds.
   */
  lens:         string;

  /** Concurrent fetches within one venue. Venues never wait on each other. */
  concurrency:  number;
};

/** One object of a bucket listing, in S3's own field names. */
export interface BucketObject {
  /** The canonical archive path, below the venue's folder — where the file is written. */
  Key:           string;

  /** The catalog's own number for the file, which is what a report names it by. */
  FileId:        number;

  /** Joined to the page's `BaseUrl`, the address the file is fetched from. */
  Url:           string;
  ETag?:         string;
  Size?:         number;
  LastModified?: string;
}

/** One page of a venue's bucket, as `GET /buckets/:venue` answers it. */
export interface BucketPage {
  Name:        string;
  Marker:      string;
  MaxKeys:     number;
  IsTruncated: boolean;
  NextMarker?: string;

  /** What every object's `Url` is joined to; empty where each `Url` is whole. */
  BaseUrl:     string;
  Contents:    BucketObject[];
}

/** One file to bring to disk: where it goes, where it comes from, and what it must be. */
export interface Haulable {
  venue: string;
  key:   string;
  url:   string;
  size?: number;
  etag?: string;
}

/** What happened to one file. */
export type Outcome = 'downloaded' | 'present' | 'failed' | 'mismatched';

/** What one fetch came to, with what was seen where it disagreed. */
export interface Hauled {
  outcome: Outcome;

  /** The size actually received, where it disagreed with the listing. */
  size?:   number;
}

/**
 * What became of a page, by `FileId`, for `POST /buckets/:venue/report`.
 * A file already on disk and correct is reported as downloaded.
 */
export interface Report {
  downloaded: number[];
  failed:     number[];
  mismatched: { FileId: number; Size?: number }[];
}

/** What one walk of a venue's bucket came to. */
export interface Walked {
  /** Objects the walk was handed. */
  listed:     number;

  /** Files brought to disk or found there already — the walk's progress. */
  progressed: number;
  failed:     number;
  mismatched: number;
}
