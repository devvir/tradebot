import { fileOfKey } from './listings/keys';
import type { DatabaseSync } from 'node:sqlite';
import type { Lens, ReportError, ReportedById, ReportedByKey } from './types';

/**
 * What a downloader says became of the files it was listed, by Key — turned into
 * what prospector settles, by file id, and the keys that cannot be.
 *
 * **The catalog owns Keys and lenses; prospector owns a file's state.** So each
 * key is resolved here, and, where the report reads through a lens, checked
 * against it: a key naming no file is `NoSuchKey`, one the lens does not let
 * through is `AccessDenied`, and neither reaches prospector. Everything else is
 * forwarded as ids, which is the only way prospector names a file.
 */

/** Most keys one report may name. */
export const MAX_REPORT = 10_000;

/** The ids to settle, and the keys that could not be. Null where the body is not a report. */
export const resolveReport = (
  db:   DatabaseSync,
  body: unknown,
  lens: Lens | null,
): { settle: ReportedById; errors: ReportError[] } | null => {
  const asked = shapeOf(body);

  if (! asked) return null;

  const settle: ReportedById = { downloaded: [], failed: [], mismatched: [] };
  const errors: ReportError[] = [];

  const idOf = (key: string): number | null => {
    const found = fileOfKey(db, key, lens);

    if (typeof found !== 'string') return found.id;

    errors.push({ Key: key, Code: found, Message: MESSAGES[found] });

    return null;
  };

  for (const key of asked.downloaded) {
    const id = idOf(key);

    if (id !== null) settle.downloaded.push(id);
  }

  for (const key of asked.failed) {
    const id = idOf(key);

    if (id !== null) settle.failed.push(id);
  }

  for (const one of asked.mismatched) {
    const id = idOf(one.Key);

    if (id !== null)
      settle.mismatched.push({
        FileId: id,
        ...(one.Size === undefined ? {} : { Size: one.Size }),
        ...(one.ETag === undefined ? {} : { ETag: one.ETag }),
      });
  }

  return { settle, errors };
};

/** How many keys a report names — what `MAX_REPORT` bounds. */
export const keysIn = (body: unknown): number => {
  const asked = shapeOf(body);

  return asked ? asked.downloaded.length + asked.failed.length + asked.mismatched.length : 0;
};

// ── Internals ─────────────────────────────────────────────────────────────────

const MESSAGES: Record<'NoSuchKey' | 'AccessDenied', string> = {
  NoSuchKey:    'No catalogued file has this key',
  AccessDenied: 'The lens this report reads through does not let this file through',
};

/** The report a body states, or null where it is not one: three lists, of keys. */
const shapeOf = (body: unknown): ReportedByKey | null => {
  const given = (body ?? {}) as Record<string, unknown>;
  const keys  = (raw: unknown): string[] | null =>
    (raw === undefined ? [] : Array.isArray(raw) && raw.every(one => typeof one === 'string') ? raw : null);

  const downloaded = keys(given['downloaded']);
  const failed     = keys(given['failed']);
  const mismatched = given['mismatched'] === undefined ? [] : given['mismatched'];

  if (! downloaded || ! failed || ! Array.isArray(mismatched)) return null;

  if (! mismatched.every(one => one && typeof one === 'object' && typeof (one as { Key?: unknown }).Key === 'string'))
    return null;

  return { downloaded, failed, mismatched: mismatched as ReportedByKey['mismatched'] };
};
