/**
 * A discovered source file `<day>.<infix>.csv` within a single-source folder.
 * `infix` is everything between the day prefix and the `.csv` extension
 * (e.g. `local`, `antel`, `prepared`).
 */
export interface SourceFile {
  name:  string;
  day:   string; // YYYYMMDD
  infix: string;
}

/**
 * An open output for one destination day. `fd` points at the `.tmp` file
 * (renamed to `final` on close); contiguous runs are written straight to it
 * from the read buffer. `fd` is -1 in dry-run.
 */
export interface Out {
  fd:    number;
  final: string;
}
