import config from './config';
import { filesOfKeys } from './listings/keys';
import { MAX_KEYS } from './listings/s3';
import { send } from './prospector';
import type { DatabaseSync } from 'node:sqlite';
import type { Lens, ReportError, ReportedById, ReportedByKey } from './types';

/**
 * What a client says became of the files it was listed, by Key — turned into
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

/**
 * Most failed and mismatched keys one report may name, together.
 *
 * **Each is a file prospector asks its venue about before it answers**, one
 * after another, where a download is only recorded: they are what a report's
 * settlement spends its time on, and the whole of it must fit `config.settleMs`
 * or the report is answered as not settled while prospector may still be
 * settling it. The cap is a listing's largest page, so the report of any page
 * a client was listed fits under it, and `config.settleMs` is the wait for that
 * many files asked about.
 */
export const MAX_TO_CONFIRM = MAX_KEYS;

/**
 * The report a body states, or null where it is not one: `downloaded` and
 * `failed`, each a list of keys, and `mismatched`, a list of `{ Key, Size, ETag
 * }` — Size a whole number and ETag a string, each optional. A list left out is
 * empty, and nothing else a body holds is kept.
 */
export const reportOf = (body: unknown): ReportedByKey | null => {
  if (! isRecord(body)) return null;

  const keys = (raw: unknown): string[] | null =>
    (raw === undefined ? [] : Array.isArray(raw) && raw.every(one => typeof one === 'string') ? raw : null);

  const downloaded = keys(body['downloaded']);
  const failed     = keys(body['failed']);
  const mismatched = body['mismatched'] === undefined ? [] : body['mismatched'];

  if (! downloaded || ! failed || ! Array.isArray(mismatched) || ! mismatched.every(isMismatch)) return null;

  return {
    downloaded,
    failed,
    mismatched: mismatched.map(({ Key, Size, ETag }) => ({
      Key,
      ...(Size === undefined ? {} : { Size }),
      ...(ETag === undefined ? {} : { ETag }),
    })),
  };
};

/** How many keys a report names — what `MAX_REPORT` bounds. */
export const keysIn = (asked: ReportedByKey): number =>
  asked.downloaded.length + asked.failed.length + asked.mismatched.length;

/** How many failed and mismatched keys a report names — what `MAX_TO_CONFIRM` bounds. */
export const toConfirmIn = (asked: ReportedByKey): number =>
  asked.failed.length + asked.mismatched.length;

/** The ids to settle, and the keys that could not be. */
export const resolveReport = (
  db:    DatabaseSync,
  asked: ReportedByKey,
  lens:  Lens | null,
): { settle: ReportedById; errors: ReportError[] } => {
  const settle: ReportedById = { downloaded: [], failed: [], mismatched: [] };
  const errors: ReportError[] = [];

  // Every key at once: a report names a page, and a page's keys share their series' days.
  const files = filesOfKeys(db, [...asked.downloaded, ...asked.failed, ...asked.mismatched.map(one => one.Key)], lens);

  const idOf = (key: string): number | null => {
    const found = files.get(key)!;

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

/**
 * Hand prospector the ids to settle; nothing is sent where there are none.
 * Throws `Refused` where prospector answers that it does not settle them, and
 * whatever `send` throws where it does not answer, or not in time.
 *
 * **Settling is idempotent**, so a connection that fails is tried again as
 * `send` tries any idempotent request, up to three attempts in all: a download
 * is recorded once, and a failure or a mismatch is asked of the venue again. An
 * answer is never retried.
 */
export const settle = async (ids: ReportedById): Promise<void> => {
  if (ids.downloaded.length === 0 && ids.failed.length === 0 && ids.mismatched.length === 0) return;

  const answer = await send('POST', '/reports', ids, { timeoutMs: config.settleMs, idempotent: true });

  if (answer.status < 200 || answer.status >= 300) throw new Refused(answer.status, messageOf(answer.body));
};

/** Prospector's own answer, refusing a report: its status and what it said. */
export class Refused extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

// ── Internals ─────────────────────────────────────────────────────────────────

const MESSAGES: Record<'NoSuchKey' | 'AccessDenied', string> = {
  NoSuchKey:    'No catalogued file has this key',
  AccessDenied: 'The lens this report reads through does not let this file through',
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && ! Array.isArray(value);

/** A mismatched file as a report states it: its Key, and the Size and ETag the client found, where it says. */
const isMismatch = (one: unknown): one is ReportedByKey['mismatched'][number] =>
  isRecord(one)
  && typeof one['Key'] === 'string'
  && (one['Size'] === undefined || (Number.isSafeInteger(one['Size']) && (one['Size'] as number) >= 0))
  && (one['ETag'] === undefined || typeof one['ETag'] === 'string');

/** What prospector said in refusing: its `error`, or the start of whatever else it answered. */
const messageOf = (body: unknown): string =>
  (isRecord(body) && typeof body['error'] === 'string' ? body['error'] : String(body ?? '').slice(0, 200))
  || 'Prospector refused the report';
