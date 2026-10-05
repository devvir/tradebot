import { logger } from '@devvir/service-kit';
import { correctFile, markDownloaded, withdrawFile } from './catalog';
import { etagOf } from './etag';
import { adaptersForVenue } from './venues';
import type { DatabaseSync } from 'node:sqlite';
import type { Adapter, Asked, Listed, ReportFile, Reported, ReportedById, Settled, Settling, Unsettled } from './types';

/**
 * What a downloader says became of the files it was listed.
 *
 * **The downloader reports; this service rules.** A file it fetched is recorded
 * as on disk. One that would not come, or came wrong, is not believed but asked
 * of the venue, and what the venue says is what gets written — so the one
 * service that writes a file's state is the one that checks it.
 */

/** Most files one report may name. */
export const MAX_REPORT = 10_000;

/**
 * A report by file id, settled. An id that names no confirmed file is counted in
 * `unknown` and otherwise ignored: ids arrive from outside and are input, not
 * facts.
 */
export const settleById = async (db: DatabaseSync, body: Partial<ReportedById>): Promise<Reported> => {
  const downloaded = Array.isArray(body.downloaded) ? body.downloaded : [];
  const failed     = Array.isArray(body.failed) ? body.failed : [];
  const mismatched = Array.isArray(body.mismatched) ? body.mismatched : [];

  let unknown = 0;

  const find = (id: unknown): ReportFile | null => {
    const file = typeof id === 'number' ? fileById(db, id) : null;

    if (! file) unknown++;

    return file;
  };

  const known = <T>(one: T | null): one is T => one !== null;

  const settled = await settleReport(db, {
    downloaded: downloaded.map(find).filter(known),
    failed:     failed.map(find).filter(known),
    mismatched: mismatched
      .map(one => {
        const file = find(one?.FileId);

        return file
          ? { file, claimed: {
            ...(one.Size === undefined ? {} : { size: one.Size }),
            ...(one.ETag === undefined ? {} : { etag: etagOf(one.ETag) }),
          } }
          : null;
      })
      .filter(known),
  });

  return { ...settled, unknown };
};

/**
 * What became of a page, settled: on disk where the downloader says so, and
 * asked of the venue wherever the downloader reports a problem.
 *
 * **The caller reports problems; this service rules on them.** A file that would
 * not come is asked about, not believed: the venue either still serves it — so
 * it stays owed and comes round again — or it has gone, and is ruled absent so
 * nothing is left outstanding. A disagreement about the bytes is settled the
 * same way, by asking. Shared by every report, whatever key it names files by.
 *
 * **Only the venue saying so withdraws a file.** Where it could not be asked,
 * or answered something that says nothing about the file, nothing is written:
 * the file stays owed, and is reported again the next time it will not come.
 */
const settleReport = async (db: DatabaseSync, report: Settling): Promise<Settled> => {
  const recorded = markDownloaded(db, report.downloaded, new Date().toISOString());

  let withdrawn = 0;

  for (const file of report.failed) {
    const adapter = adapterFor(db, file.venueId);
    const asked   = adapter ? await confirm(db, adapter, file.path) : UNKNOWN;

    if (asked.file) {
      logger.warn({ path: file.path }, 'Reported as undownloadable, but the venue still serves it');

      continue;
    }

    if (! asked.absent) {
      logger.warn({ path: file.path, ...(asked.status === undefined ? {} : { status: asked.status }) },
        'Reported as undownloadable, and the venue did not say whether it has it; left owed');

      continue;
    }

    withdrawn += withdrawFile(db, file.venueId, file.path, asked.status) ? 1 : 0;
  }

  let corrected = 0;

  for (const { file, claimed } of report.mismatched)
    corrected += await reconcile(db, file, claimed, false) ? 1 : 0;

  return { recorded, withdrawn, corrected };
};


// ── Internals ─────────────────────────────────────────────────────────────────

/** The confirmed file an id names; null where it names none. */
const fileById = (db: DatabaseSync, id: number): ReportFile | null => {
  if (! Number.isSafeInteger(id) || id < 1) return null;

  const file = db.prepare(
    `SELECT venue_id AS venueId, path FROM file WHERE rowid = ? AND existence = 'confirmed'`,
  ).get(id) as ReportFile | undefined;

  return file ?? null;
};

/**
 * Check a claim against the venue, then record what the venue said.
 *
 * **What prospector confirms is what gets written, not what it was told.** A
 * downloader is almost always right — an archive is insert-only unless somebody
 * erred — but almost always is not a thing to write into a database on, and the
 * alternative to asking is finding out at the next full survey, days away. It
 * costs one request and fires almost never.
 *
 * A disagreement is logged loudly and the file stays owed: whatever the caller
 * holds, it demonstrably is not what the venue is serving.
 */
const reconcile = async (
  db:         DatabaseSync,
  file:       { venueId: number; path: string },
  claimed:    Partial<Listed>,
  downloaded = true,
): Promise<boolean> => {
  const adapter = adapterFor(db, file.venueId);

  if (! adapter) return false;

  const seen = (await confirm(db, adapter, file.path)).file;

  if (! seen) {
    logger.warn({ path: file.path, claimed }, 'Could not confirm a reported change');

    return false;
  }

  // The ETag is compared case-blind: the case is the server's, not the file's,
  // and a downloader that upper-cased what a venue lower-cased has not seen a
  // different file.
  const agrees = (claimed.size == null || claimed.size === seen.size)
    && (claimed.etag == null || claimed.etag.toLowerCase() === seen.etag?.toLowerCase());

  if (! agrees)
    logger.error({ path: file.path, claimed, seen },
      'Reported file differs from the venue; keeping what the venue has');

  return correctFile(
    db, file.venueId, file.path,
    { size: seen.size, etag: seen.etag, modified: seen.modified },
    new Date().toISOString(),
    downloaded && agrees,
  );
};

/**
 * Ask the venue about one key, through the context its scanner expects, and
 * say what its answer means.
 *
 * **Three outcomes, and only one of them is absence.** The venue serves the
 * file; the venue says it does not have it; or nothing was learned about the
 * file at all — the request failed, timed out, or was answered with something
 * that speaks of the way to the file and not of the file.
 *
 * **What an answer means is the adapter's to say.** A `2xx` is the file.
 * Anything else goes to the venue's `ruleOnFailure`, which knows how its venue
 * spells absence: `'drop'` is absence, `'keep'` is not, whatever the status.
 * Where the adapter has no rule, or its rule declines, absence is the statuses
 * the venue names in `notFoundCodes` — `404` unless it says otherwise — and
 * every other answer is unknown. One such answer is enough: an adapter that
 * wants more patience than that has the hook to ask for it.
 *
 * **A scanner is never handed an adapter.** It is written against the context
 * its venue builds — `text` and `head` already paced, or a set of ranges — and
 * an adapter carries none of those, so passing one meant every confirmation
 * threw and was swallowed as "could not confirm". The generic `Scanner<any>` in
 * the registry is what let that compile.
 *
 * Built per call rather than held, with `'lookup'` as the occasion — the one
 * that reaches no venue, so an adapter cannot turn a single confirmation into an
 * unbounded call inside a request handler.
 */
const confirm = async (
  db:      DatabaseSync,
  adapter: Adapter,
  path:    string,
): Promise<Asked> => {
  let said;

  try {
    said = await adapter.scanner.confirm(await adapter.getContext(db, 'lookup'), path);
  } catch (err) {
    logger.warn({ path, error: (err as Error).message }, 'Could not ask the venue about a file');

    return UNKNOWN;
  }

  if (said === null) return UNKNOWN;
  if (said === 'absent') return { file: null, absent: true };
  if (! ('status' in said)) return { file: said, absent: false };

  const { status, headers } = said;

  const row = db.prepare(
    `SELECT rowid AS seq, venue_id AS venueId, path, date, series_id AS seriesId FROM file
      WHERE venue_id = (SELECT id FROM venue WHERE name = ? AND host = ?) AND path = ?`,
  ).get(adapter.name, adapter.host ?? '', path) as { seq: number; venueId: number; path: string; date: string; seriesId: number } | undefined;

  const verdict = row && adapter.ruleOnFailure
    ? adapter.ruleOnFailure({ ...row, tries: 0, existence: 'confirmed' } as Unsettled, status, headers, 1)
    : null;

  const absent = verdict === 'drop'
    || (verdict === null && (adapter.notFoundCodes ?? NOT_FOUND).includes(status));

  return { file: null, absent, status };
};

/** Nothing was learned about the file. */
const UNKNOWN: Asked = { file: null, absent: false };

/** How a venue says a key is not there, where it names nothing else. */
const NOT_FOUND: readonly number[] = [404];

const adapterFor = (db: DatabaseSync, venueId: number): Adapter | null => {
  const row = db.prepare('SELECT name, host FROM venue WHERE id = ?')
    .get(venueId) as { name: string; host: string } | undefined;

  if (! row) return null;

  return adaptersForVenue(row.name).find(one => (one.host ?? '') === row.host) ?? null;
};

