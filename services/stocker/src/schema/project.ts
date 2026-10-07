import { MARGIN, fieldsOf } from './tables';
import type { Series } from '../types';

/**
 * Build the full SELECT that turns one venue's raw relation into the canonical
 * table: `selectFor(series, relation)` → projection over a wrapped relation.
 *
 * Every series emits the table's full column list, in the table's order, with
 * NULL where the venue publishes nothing — all but `margin`, which the writer
 * fills per instrument — followed by any `extra` expressions the caller needs
 * carried through, such as the column naming each row's instrument. That is
 * what makes a table one
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
export const selectFor = (series: Series, relation: string, extra: string[] = []): string =>
  `SELECT ${[projectionFor(series), ...extra].join(', ')} FROM ` +
  `(SELECT *, ${fractionCols()} FROM (SELECT *, ${integralCols(series.ts)} FROM ${rowsOf(series, relation)}))`;

// ── Internals ─────────────────────────────────────────────────────────────────

/** What the projection reads: the format's relation, or the series' own rows made from it. */
const rowsOf = (series: Series, relation: string): string =>
  (series.rows ? `(${series.rows.replaceAll('{src}', relation)})` : relation);

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
    .filter(field => field.name !== MARGIN.name)
    .map(field => {
      if (field.name === 'ts') return `${utcOf(series)} AS ts`;

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
 * Second inner projection: a fractional epoch split at its one dot, as a whole
 * part and nine fractional digits — both integers, only where the integer
 * parse did not apply.
 *
 * **Integers, never DOUBLE and never DECIMAL.** An epoch in microseconds is a
 * 16-digit integer, at the edge of what a double holds exactly, so a DOUBLE
 * multiply would silently round the last digit. DECIMAL(38,9) is exact and was
 * the parse here, and it is ruinous: on one day of bybit perpetual trades
 * (71k rows) it took 5.5 s where this split takes 0.23 s, with identical
 * results on every row (measured 2026-10-04). Every venue stamping fractional
 * seconds — bybit's perpetuals, all of gate — was paying it on every row.
 *
 * Exactly one dot, and digits after it, or this is not a fractional epoch:
 * `2024.11.01 00:00` has two and falls through to the datetime parse.
 */
const fractionCols = (): string => {
  const single   = `_tsInt IS NULL AND length(_tsText) - length(replace(_tsText, '.', '')) = 1`;
  const fraction = `rpad(split_part(_tsText, '.', 2), 9, '0')`;

  return `CASE WHEN ${single} AND TRY_CAST(${fraction} AS BIGINT) IS NOT NULL ` +
      `THEN TRY_CAST(split_part(_tsText, '.', 1) AS BIGINT) END AS _tsWhole, ` +
    `CASE WHEN ${single} THEN ${fraction} END AS _tsFrac`;
};

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
 * Both paths round half-up to the microsecond: the nanosecond branch adds 500
 * before dividing, and the fractional one adds the digit past the last one it
 * keeps — the two must not disagree about the same instant.
 */
const microsOf = (): string =>
  `CASE ` +
  `WHEN _tsInt IS NOT NULL THEN CASE ` +
    `WHEN abs(_tsInt) < 100000000000 THEN _tsInt * 1000000 ` +
    `WHEN abs(_tsInt) < 100000000000000 THEN _tsInt * 1000 ` +
    `WHEN abs(_tsInt) < 100000000000000000 THEN _tsInt ` +
    `ELSE (_tsInt + 500) // 1000 END ` +
  `WHEN _tsWhole IS NOT NULL THEN CASE ` +
    `WHEN abs(_tsWhole) < 100000000000 THEN _tsWhole * 1000000 + ${digits(6)} ` +
    `WHEN abs(_tsWhole) < 100000000000000 THEN _tsWhole * 1000 + ${digits(3)} ` +
    `WHEN abs(_tsWhole) < 100000000000000000 THEN _tsWhole + ${digits(0)} ` +
    `ELSE (_tsWhole + 500) // 1000 END ` +
  `ELSE epoch_us(COALESCE(` +
    `TRY_CAST(_tsText AS TIMESTAMP), ` +
    `try_strptime(_tsText, '%Y.%m.%d %H:%M'), ` +
    `try_strptime(_tsText, '%Y.%m.%d %H:%M:%S'))) END`;

/** The first `keep` fractional digits as an integer, rounded half-up on the next one. */
const digits = (keep: number): string =>
  (keep ? `CAST(substr(_tsFrac, 1, ${keep}) AS BIGINT) + ` : '') +
  `CASE WHEN substr(_tsFrac, ${keep + 1}, 1) >= '5' THEN 1 ELSE 0 END`;

/**
 * The timestamp in UTC microseconds: inferred, then moved out of the zone a
 * venue writes its local datetimes in, where it declares one.
 */
const utcOf = (series: Series): string =>
  series.utcOffsetHours
    ? `(${microsOf()} - ${series.utcOffsetHours * 3_600_000_000})`
    : microsOf();

// ── Test access ───────────────────────────────────────────────────────────────

export const _test_projectionFor = projectionFor;
export const _test_microsOf      = microsOf;
export const _test_integralCols  = integralCols;
export const _test_fractionCols  = fractionCols;
