// Closed-file parsing — turns a vault file's bytes into records.
//
// Two strategies, chosen per table and hidden behind `createParser`:
//
//   - Free-text tables (announcement, chat, publicNotifications) carry fields
//     that can contain commas, double quotes, or embedded newlines, so they
//     need a full RFC 4180 parser. A line-based reader would fragment a quoted
//     field at its embedded `\n` before any consumer saw it as one field.
//
//   - Every other table holds only numbers, symbols, and ISO timestamps, so
//     each physical line is exactly one record. A line without a `"` is split
//     on plain commas — several times faster than the RFC 4180 parser. A line
//     with a `"` is split by a single-line RFC 4180 splitter, so a quoted
//     value still reads as one field; a quoted field left open at the end of
//     the line (its record was broken by an embedded line break) throws rather
//     than yielding misaligned fields.
//
// Skip is part of the strategy, not bolted on after. On comma-split tables a
// skipped message is never split into fields: its raw line is inspected only
// for a leading comma (an empty `_date_`, i.e. a continuation row) to find
// message boundaries; only surviving lines are split.

import readline from 'node:readline';
import { pipeline } from 'node:stream/promises';
import { baseTable, createCsvParser, FREE_TEXT_TABLES, WS_TABLES } from '@tradebot/utils';
import { openClosedFile } from '../fs/reader';
import type { VaultParser } from './types';

/**
 * Returns the parser for a table. Callers stream records via `read` and never
 * need to know which strategy backs it — only free-text tables pay the cost of
 * the full RFC 4180 parser.
 */
export const createParser = (table: string): VaultParser => {
  const strategy = FREE_TEXT_TABLES.has(baseTable(table)) ? rfc4180 : commaSplit;

  return {
    read: (filename: string, skip = 0) => strategy(table, filename, skip),
  };
};

// ── Strategies ────────────────────────────────────────────────────────────────

/**
 * Comma-split strategy — for every non-free-text table. Reads physical lines
 * and splits each with `splitLine`. Skipped messages are never split: only a
 * leading comma is checked to detect continuation rows on WS tables.
 */
async function* commaSplit(
  table:    string,
  filename: string,
  skip:     number,
): AsyncGenerator<string[]> {
  const { stream, close } = openClosedFile(table, filename);

  try {
    const src    = readLines(stream);
    const header = await src.next();

    if (header.done) return;

    const split = (line: string): string[] => splitLine(line, table, filename);

    yield split(header.value);

    // REST tables store one record per line — no continuation rows, so every
    // line opens a new message. WS tables mark continuation rows with an empty
    // `_date_`, which on disk is a leading comma.
    const isContinuation = WS_TABLES.has(baseTable(table))
      ? (line: string) => line.startsWith(',')
      : () => false;

    for await (const line of afterSkip(src, skip, isContinuation)) {
      yield split(line);
    }
  } finally {
    await close();
  }
}

/**
 * RFC 4180 strategy — for free-text tables. Routes the decompressed bytes
 * through the shared CSV parser so quoted fields with embedded commas, quotes,
 * or newlines round-trip as a single field. Skip works on parsed records — a
 * quoted field can span physical lines, so boundaries can only be known after
 * parsing.
 */
async function* rfc4180(
  table:    string,
  filename: string,
  skip:     number,
): AsyncGenerator<string[]> {
  const { stream, close } = openClosedFile(table, filename);

  try {
    const src    = csvRecords(stream);
    const header = await src.next();

    if (header.done) return;

    yield header.value;

    yield* afterSkip(src, skip, record => record[0] === '');
  } finally {
    await close();
  }
}

/**
 * Splits one physical line into fields. A line without `"` is split on every
 * comma. Otherwise fields are read per RFC 4180: a field that opens with `"`
 * runs to the matching closing `"`, with `""` standing for one `"`. Throws when
 * a quoted field is still open at the end of the line, or when a `"` appears
 * where RFC 4180 does not allow one.
 */
const splitLine = (line: string, table: string, filename: string): string[] => {
  if (! line.includes('"')) return line.split(',');

  const fields: string[] = [];
  let i = 0;

  for (;;) {
    if (line[i] !== '"') {
      const end   = line.indexOf(',', i);
      const field = end === -1 ? line.slice(i) : line.slice(i, end);

      if (field.includes('"'))
        throw new Error(`Malformed quoted field in comma-split table ${table}/${filename}`);

      fields.push(field);

      if (end === -1) return fields;

      i = end + 1;
      continue;
    }

    let field = '';
    let j     = i + 1;

    for (;;) {
      const quote = line.indexOf('"', j);

      if (quote === -1)
        throw new Error(`Quoted multi-line field in comma-split table ${table}/${filename}`);

      field += line.slice(j, quote);

      if (line[quote + 1] === '"') {
        field += '"';
        j = quote + 2;
        continue;
      }

      j = quote + 1;
      break;
    }

    fields.push(field);

    if (j === line.length) return fields;

    if (line[j] !== ',')
      throw new Error(`Malformed quoted field in comma-split table ${table}/${filename}`);

    i = j + 1;
  }
};

// ── Skip ──────────────────────────────────────────────────────────────────────

/**
 * Drops the first `skip` messages from a record/line stream, then yields the
 * rest. A message starts at the first non-continuation item and includes every
 * continuation item that follows it.
 */
async function* afterSkip<T>(
  items:          AsyncIterable<T>,
  skip:           number,
  isContinuation: (item: T) => boolean,
): AsyncGenerator<T> {
  let remaining = skip;
  let skipping  = remaining > 0;

  for await (const item of items) {
    if (! isContinuation(item)) {
      if (remaining > 0) {
        remaining--;
        skipping = true;
      } else {
        skipping = false;
      }
    }

    if (skipping) continue;

    yield item;
  }
}

// ── Record sources ────────────────────────────────────────────────────────────

/** Yields the non-empty physical lines of a decompressed file. */
async function* readLines(stream: NodeJS.ReadableStream): AsyncGenerator<string> {
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (line.length > 0) yield line;
  }
}

/**
 * Yields RFC 4180 records parsed from a decompressed file. A decompression
 * error (a truncated or non-gzip file) rejects the iteration with that error.
 */
async function* csvRecords(stream: NodeJS.ReadableStream): AsyncGenerator<string[]> {
  const parser = createCsvParser(false);

  // The pipeline destroys the parser with any error of the source, so the
  // iteration below rejects with it. It also rejects when the iteration stops
  // early; that is not an error.
  const piped = pipeline(stream, parser).catch(() => {});

  try {
    for await (const record of parser as AsyncIterable<string[]>) {
      yield record;
    }
  } finally {
    parser.destroy();
    await piped;
  }
}
