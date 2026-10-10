/** A day with both pool-segregated sources present, and its merge output path. */
export interface PairFile {
  day:           string;   // YYYYMMDD
  primaryPath:   string;
  secondaryPath: string;
  outPath:       string;   // <day>.merged.csv.gz
}

/**
 * A pull-based line reader over one gzipped CSV: `peek` is the current line
 * (null at EOF), `next()` advances. `sym` and `ts` are parsed lazily from the
 * current line for the block walk / timestamp merge.
 */
export interface LineCursor {
  peek: string | null;
  sym:  string;
  ts:   string;
  next(): Promise<void>;
}
