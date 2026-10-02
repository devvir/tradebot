import type { DatabaseSync } from 'node:sqlite';

/** A scratch catalog, and how to throw it away. */
export interface Scratch {
  db:    DatabaseSync;
  close: () => void;
}

/** A series as a test describes one; absent fields are unset. */
export interface SeriesSpec {
  market:     string;
  dataset:    string;
  variant?:   string;
  symbol:     string;
  urlSymbol?: string;
  pattern:    string;
  first?:     string;
  last?:      string;
  retiredAt?: string;
}

/** A file as a test describes one, confirmed; size 10 and pending unless said otherwise. */
export interface FileSpec {
  venueId:     number;
  seriesId:    number;
  path:        string;
  date:        string;
  size?:       number;
  etag?:       string;
  modified?:   string | null;
  existence?:  'confirmed' | 'absent';

  // Accepted and ignored: prospector's write helper takes them, and the tests are written against it.
  seenAt?:     string;
}
