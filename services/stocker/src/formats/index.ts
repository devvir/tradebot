import { open } from 'node:fs/promises';
import { csv } from './csv';
import { lines } from './lines';
import { ndjson } from './ndjson';
import { words } from './words';
import { xlsx } from './xlsx';
import type { Format } from './types';

const FORMATS: Record<string, Format> = { csv, lines, ndjson, words, xlsx };

export const formatFor = (name: string): Format => {
  const format = FORMATS[name];

  if (! format)
    throw new Error(`Unknown format '${name}'. Known: ${Object.keys(FORMATS).join(', ')}`);

  return format;
};

/**
 * How a table is written, read off the file and not off the map.
 *
 * **A table is a table whether a venue writes it as text or as a sheet.** The
 * columns and what they mean are the series'; which of the two a file is
 * changes only how its cells are got at, and a venue changes that without
 * saying so — bitget writes a day's klines as a sheet and a month's as text.
 * So a series that reads a table declares either, and each file answers for
 * itself: a sheet is a zip archive and opens with its signature, and anything
 * else is text.
 *
 * Formats that are not tables — records a line, lines, words — are what the
 * series says they are: nothing in such a file tells them apart.
 */
export const formatOf = async (declared: string, path: string): Promise<string> => {
  if (! TABLES.has(declared)) return declared;

  const file = await open(path, 'r');

  try {
    const { buffer, bytesRead } = await file.read(Buffer.alloc(4), 0, 4, 0);

    return bytesRead === 4 && buffer.equals(SHEET) ? 'xlsx' : 'csv';
  } finally {
    await file.close();
  }
};

/** Whether a series' files are a table, whichever way a file of it is written. */
export const isTable = (declared: string): boolean => TABLES.has(declared);

// ── Internals ─────────────────────────────────────────────────────────────────

/** The formats that are a table, and so one another's alternatives. */
const TABLES = new Set(['csv', 'xlsx']);

/** How a zip archive opens, which an `.xlsx` is. */
const SHEET = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

export type { Format } from './types';
