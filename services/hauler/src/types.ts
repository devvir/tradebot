/**
 * Everything hauler names, fetches and reports, in one place.
 *
 * **Hauler reads a bucket.** The catalog serves every venue as one storage
 * bucket keyed by what a file *is* — the canonical archive path, venue first —
 * so hauler writes each object at its key and needs no vocabulary of its own.
 * See the catalog API's listing.
 */

/** What this deployment fetches, and from where. */
export type Config = {
  /** Where the archives are written, inside the container. */
  archivesDir:  string;

  catalogApi:   string;

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

  /** Free space on the archives' volume below which nothing more is fetched, in GB. */
  minFreeGb:    number;
};

/** One object of a bucket listing, in S3's own field names. */
export interface BucketObject {
  /** The canonical archive path, venue first — where the file is written, and how a report names it. */
  Key:           string;

  /** The file's own path, below whichever address its server is reached at. */
  Path:          string;

  /** Which of the venue's servers holds it: `''` where the venue has one. */
  Host:          string;
  ETag?:         string;
  Size?:         number;
  LastModified?: string;
}

/** One page of the bucket, as `GET /listings?prefix=<venue>/` answers it. */
export interface BucketPage {
  Name:        string;
  Prefix:      string;
  Marker:      string;
  MaxKeys:     number;
  IsTruncated: boolean;
  NextMarker?: string;
  Contents:    BucketObject[];
}

/** One listed page as a walk works through it: how much of it is left, and what came of the rest. */
export interface Leaf {
  /** Objects the page listed. */
  size:      number;

  /** Objects not yet settled; the page is reported when none are. */
  left:      number;

  /** Files the network would not bring, which go unreported. */
  unreached: number;
  done:      Report;
}

/** One file to bring to disk: where it goes, where it comes from, and what it must be. */
export interface Haulable {
  venue: string;
  key:   string;

  /** The venue's server that holds it, and its path there. */
  server: string;
  path:   string;
  size?: number;
  etag?: string;
}

/** One address a venue's server answers at, and how it has been doing. */
export interface Host {
  venue:  string;
  server: string;

  /** The address up to where a file's path begins. */
  base:   string;

  /** Whether this is the address the catalog lists: the one whose word on a file is the venue's. */
  main:   boolean;

  /** Its share of the server's requests, of 1. */
  weight: number;

  /** Bytes per second while delivering, less its failures; null until it has been measured. */
  score:  number | null;

  /** Since the weights were last looked at: bytes delivered, time in flight, files delivered, requests that failed. */
  bytes:  number;
  ms:     number;
  ok:     number;
  errors: number;

  /** Refusals in a row, nothing delivered between them. */
  refusals: number;

  /** Until when it is out of rotation, in epoch milliseconds; in it where that has passed. */
  outUntil: number;

  /** Times running it has been taken out, which lengthens the next. */
  strikes:  number;

  /** Since when its share has been at the floor, or null where it is above it. */
  lowSince: number | null;

  /** Until when it is on trial: given a fixed share, whatever it scores. */
  trialUntil: number;
}

/** What happened to one file. */
/** A download that did not agree with the catalog, kept in scratch until the catalog has asked the venue. */
export interface Withheld {
  /** Where the file belongs: its partial in scratch is named after it. */
  path:   string;
  bytes:  number;

  /** The MD5 of what was fetched, in hex. */
  digest: string;
}

export type Outcome = 'downloaded' | 'present' | 'failed' | 'mismatched' | 'unreached';

/** What one fetch came to, with what was seen where it disagreed. */
export interface Hauled {
  outcome: Outcome;

  /** The size actually received, where it disagreed with the listing. */
  size?:   number;
}

/**
 * What became of a page, by Key, for `POST /listings/report`. A file already on
 * disk and correct is reported as downloaded.
 */
export interface Report {
  downloaded: string[];
  failed:     string[];
  mismatched: { Key: string; Size?: number }[];
}

/** The keys a report could not settle, as the catalog answers a `207`. */
export interface ReportAnswer {
  Error?: { Key: string; Code: string; Message: string }[];
}

/** What one walk of a venue's bucket came to. */
export interface Walked {
  /** Objects the walk was handed. */
  listed:     number;

  /** Files brought to disk or found there already — the walk's progress. */
  progressed: number;
  failed:     number;
  mismatched: number;

  /** Files the network would not bring, left unreported to come round again. */
  unreached:  number;

  /** The walk stopped taking files because the archives' volume ran low. */
  full:       boolean;
}
