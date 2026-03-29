import { existsSync, mkdirSync, createWriteStream, unlinkSync, renameSync } from 'fs';
import { pipeline } from 'stream/promises';
import type { Readable, Writable } from 'stream';
import { logger } from '@devvir/service-kit';
import { yearDir, openPath, closedPath } from './paths';
import { NotFoundError } from './errors';
import { closing, closeHandle } from './queue';

/**
 * Stores a complete pre-made binary file (e.g. a raw S3 gzip). Written
 * atomically via a tmp path — shares the `.csv.gz.tmp` name with the open-file
 * convention, so `closing` is held for the duration of the upload to prevent
 * `insertRow` from racing onto the same path. Throws if any file (open or
 * closed) already exists.
 */
export const storeFile = async (table: string, date: string, source: Readable): Promise<void> => {
  const key = `${table}/${date}`;

  closing.add(key);

  try {
    mkdirSync(yearDir(table, date), { recursive: true });

    const dest = closedPath(table, date);
    const tmp  = `${dest}.tmp`;

    try {
      await pipeline(source, createWriteStream(tmp) as unknown as Writable);
      renameSync(tmp, dest);
    } catch (err) {
      if (existsSync(tmp)) unlinkSync(tmp);
      throw err;
    }
  } finally {
    closing.delete(key);
  }
};

/**
 * Closes the open file by ending its gzip stream, waiting for the bytes to
 * land on disk, and renaming the `.csv.gz.tmp` to `.csv.gz`. The rename is
 * atomic; there is no intermediate compression step.
 */
export const closeFile = async (table: string, date: string): Promise<void> => {
  const key  = `${table}/${date}`;

  if (closing.has(key)) return;

  const open = openPath(table, date);

  if (! existsSync(open)) {
    if (existsSync(closedPath(table, date))) return;
    throw new NotFoundError(`No open file for ${table}/${date}`);
  }

  closing.add(key);

  try {
    await closeHandle(key);
    renameSync(open, closedPath(table, date));
    logger.info({ table, date }, 'File closed');
  } finally {
    closing.delete(key);
  }
};

// Discards an open file. Closes the handle first if one exists.
export const dropFile = async (table: string, date: string): Promise<void> => {
  const key = `${table}/${date}`;

  closing.add(key);

  try {
    await closeHandle(key);

    const open = openPath(table, date);

    if (! existsSync(open))
      throw new NotFoundError(`No open file for ${table}/${date}`);

    unlinkSync(open);
  } finally {
    closing.delete(key);
  }
};
