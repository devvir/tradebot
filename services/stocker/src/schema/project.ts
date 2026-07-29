import { fieldsOf } from './tables';
import type { Series } from '../types';

/**
 * Build the full SELECT that turns one venue's raw relation into the canonical
 * table: `selectFor(series, relation)` → projection over a wrapped relation.
 *
 * Every series emits the table's full column list, in the table's order, with
 * NULL where the venue publishes nothing. That is what makes a table one
 * dataset instead of a pile of venue-shaped files — a reader gets identical
 * columns whether the rows came from Binance or Gate, and Parquet gets one
 * stable schema to append to.
 *
 * The wrapping matters for speed, not shape. The timestamp parse is computed
 * **once per row** in inner projections and the unit inference reads those
 * columns; inlining the parse into every branch of the CASE — the obvious
 * one-expression form — evaluates it five times per row, and together with
 * routing every value through DECIMAL made builds ~100× slower than this.
 * Benchmarked on a month of Binance trades: 96.7s → 1.0s for 500k rows, with
 * byte-identical output.
 */
export const selectFor = (series: Series, relation: string): string =>
  `SELECT ${projectionFor(series)} FROM ` +
  `(SELECT *, ${decimalCol()} FROM (SELECT *, ${integralCols(series.ts)} FROM ${relation}))`;

// ── Internals ─────────────────────────────────────────────────────────────────

/**
 * Values convert with **`TRY_CAST`**: a cell that will not parse becomes NULL
 * rather than aborting the partition.
 *
 * A venue's own tooling leaks into its archives. OKX candlesticks carry the
 * literal string `None` — Python's, serialised — in `vol_ccy` and `vol_quote`
 * for the eras where it did not populate them, on every row of the file. A
 * strict cast turns that into a failed month: 4,678 OKX kline partitions failed
 * on one sweep for exactly this reason, and no amount of retrying would have
 * fixed it.
 *
 * NULL is also the honest reading. The venue published no number there, and the
 * canonical schema already uses NULL for "this venue does not publish it" — a
 * value that cannot be parsed is the same statement made badly.
 *
 * The cost is that a *wrongly mapped* column now yields NULLs instead of an
 * error. That trade is deliberate: `mapping.test.ts` drives every series
 * against a real file from the venue and asserts the projected values, which
 * catches a bad mapping at the point where it can be read and fixed. A failed
 * build at 3am catches it too, but only as a partition that never lands.
 *
 * Sentinels are never enumerated here. `None`, an empty string and a stray
 * header all fail the same cast, and a venue that invents a fourth spelling of
 * "no value" needs no entry anywhere.
 */
const projectionFor = (series: Series): string =>
  fieldsOf(series.table)
    .map(field => {
      if (field.name === 'ts') return `${microsOf()} AS ts`;

      const expr = series.project[field.name];

      return expr
        ? `TRY_CAST(${expr} AS ${field.type}) AS ${field.name}`
        : `CAST(NULL AS ${field.type}) AS ${field.name}`;
    })
    .join(', ');

/**
 * First inner projection: the source timestamp as trimmed text, and as BIGINT
 * where the text is integral.
 *
 * The dot guard is not an optimisation, it is correctness: DuckDB's
 * VARCHAR→BIGINT cast **rounds** fractional text rather than failing, so
 * without it Bybit's `1784937600.0683` would take the integer path and lose its
 * sub-second part in silence.
 */
const integralCols = (column: string): string => {
  const text = `trim(CAST(${column} AS VARCHAR))`;

  return `${text} AS _tsText, ` +
    `CASE WHEN strpos(${text}, '.') = 0 THEN TRY_CAST(${text} AS BIGINT) END AS _tsInt`;
};

/**
 * Second inner projection: the DECIMAL parse, only where the integer one did
 * not apply. DECIMAL rather than DOUBLE deliberately — an epoch in microseconds
 * is a 16-digit integer, right at the edge of what a double holds exactly, so a
 * DOUBLE multiply would silently round the last digit. It is also ~20× the cost
 * of the BIGINT parse, which is why it only runs for the values that need it:
 * essentially every file publishes integral epochs.
 */
const decimalCol = (): string =>
  `CASE WHEN _tsInt IS NULL THEN TRY_CAST(_tsText AS DECIMAL(38,9)) END AS _tsDec`;

/**
 * Convert the parsed source timestamp to int64 microseconds UTC, deciding its
 * unit from the value rather than from a declaration.
 *
 * Over 2015–2035 the plausible ranges sit three orders of magnitude apart —
 * seconds near 1.4e9, millis 1.4e12, micros 1.4e15, nanos 1.4e18 — so which one
 * a value belongs to follows from the value itself, with the thresholds falling
 * in empty space between them.
 *
 * A declared unit was the alternative and it does not hold: venues change
 * precision mid-history. Binance spot trades are milliseconds through 2024-12
 * and microseconds from 2025-01, inside one dataset a consumer reads as a
 * whole, so any fixed declaration is silently wrong for one side of that line.
 * Bybit stamps fractional seconds on perpetuals and integer milliseconds on
 * spot, under a header that says `timestamp` for both.
 *
 * Text forms are handled for the venues that publish a datetime rather than an
 * epoch: ISO, and the dotted `2024.11.01 00:00` of Bybit's MT4 klines.
 *
 * Anything that resolves to nothing lands as NULL — including the literal text
 * of a header row, which is how a file that grew a header partway through its
 * history is read without knowing when that happened. The build drops those
 * rows.
 *
 * The nanosecond branch adds 500 before integer division to round half-up,
 * matching what the DECIMAL division does on the fractional path — the two
 * paths must not disagree about the same instant.
 */
const microsOf = (): string =>
  `CASE ` +
  `WHEN _tsInt IS NOT NULL THEN CASE ` +
    `WHEN abs(_tsInt) < 100000000000 THEN _tsInt * 1000000 ` +
    `WHEN abs(_tsInt) < 100000000000000 THEN _tsInt * 1000 ` +
    `WHEN abs(_tsInt) < 100000000000000000 THEN _tsInt ` +
    `ELSE (_tsInt + 500) // 1000 END ` +
  `WHEN _tsDec IS NOT NULL THEN CASE ` +
    `WHEN abs(_tsDec) < 1e11 THEN CAST(_tsDec * 1000000 AS BIGINT) ` +
    `WHEN abs(_tsDec) < 1e14 THEN CAST(_tsDec * 1000 AS BIGINT) ` +
    `WHEN abs(_tsDec) < 1e17 THEN CAST(_tsDec AS BIGINT) ` +
    `ELSE CAST(_tsDec / 1000 AS BIGINT) END ` +
  `ELSE epoch_us(COALESCE(` +
    `TRY_CAST(_tsText AS TIMESTAMP), ` +
    `try_strptime(_tsText, '%Y.%m.%d %H:%M'), ` +
    `try_strptime(_tsText, '%Y.%m.%d %H:%M:%S'))) END`;

// ── Test access ───────────────────────────────────────────────────────────────

export const _test_projectionFor = projectionFor;
export const _test_microsOf      = microsOf;
export const _test_integralCols  = integralCols;
export const _test_decimalCol    = decimalCol;
