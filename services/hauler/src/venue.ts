import { logger } from '@devvir/service-kit';
import { page, report } from './catalog';
import { haul } from './fetch';
import { freeGb } from './store';
import config from './config';
import type { BucketPage, Haulable, Report, Walked } from './types';

/**
 * Walk a venue's bucket once, end to end, fetching every object it lists.
 *
 * **A bucket walk, nothing more.** The listing is already narrowed to what is
 * still owed and to the lens, and each key is where its file goes, so this only
 * pages, fetches and reports. A file the catalog adds behind the cursor is
 * listed by the next walk, as on any bucket.
 *
 * **The next page is asked for while this one is fetched**, so the listing is
 * never what anything waits on.
 *
 * **Stopping takes no new file and abandons none**: the files in flight finish,
 * and the page reports what it got through, so nothing done goes unreported.
 *
 * **So does a volume running low.** Below `minFreeGb` no new file is taken, the
 * ones in flight finish, and the walk ends saying so — rather than filling the
 * volume and failing every file after.
 *
 * **It says what it is doing as it goes**: when it asks the catalog, which can
 * take a while on a large venue, and what each page came to. A walk is hours of
 * work, and silence reads as either nothing happening or something unlogged.
 */
export const walkVenue = async (venue: string, stopped: () => boolean): Promise<Walked> => {
  const walked: Walked = { listed: 0, progressed: 0, failed: 0, mismatched: 0, unreached: 0, full: false };

  logger.info({ venue, lens: config.lens || '(none)' }, 'Walk started — asking the catalog what is owed');

  let next: Promise<BucketPage> | null = page(venue, null);
  let pages = 0;

  while (next) {
    const current: BucketPage = await next;

    if (pages === 0)
      logger.info({ venue, owed: current.Contents.length, more: current.IsTruncated },
        current.Contents.length === 0 ? 'Nothing is owed' : 'The catalog answered — fetching');
    const after   = current.IsTruncated ? current.NextMarker ?? current.Contents.at(-1)?.Key ?? null : null;

    next = after ? page(venue, after) : null;

    // Settled later, or abandoned when stopping; never left unhandled meanwhile.
    next?.catch(() => undefined);

    if (stopped()) return walked;

    const { done, unreached, full } = await workPage(venue, current, stopped);

    await report(venue, done);

    walked.listed     += current.Contents.length;
    walked.progressed += done.downloaded.length;
    walked.failed     += done.failed.length;
    walked.mismatched += done.mismatched.length;
    walked.unreached  += unreached;
    walked.full        = full;

    if (current.Contents.length > 0)
      logger.info({ venue, page: ++pages, ...walked, more: next !== null && ! full }, 'Page done');

    if (full) return walked;
  }

  return walked;
};

// ── Internals ─────────────────────────────────────────────────────────────────

/**
 * One page's objects, `config.concurrency` at a time, taking no more once
 * stopped or once the volume is low: the report, how many the network would not
 * bring — those go unreported — and whether the volume is what ended it.
 */
const workPage = async (
  venue:   string,
  current: BucketPage,
  stopped: () => boolean,
): Promise<{ done: Report; unreached: number; full: boolean }> => {
  const done: Report = { downloaded: [], failed: [], mismatched: [] };
  const queue = [...current.Contents];

  let unreached = 0;
  let full      = false;

  const worker = async (): Promise<void> => {
    for (let object = queue.shift(); object && ! stopped() && ! full; object = queue.shift()) {
      if (await low()) {
        full = true;

        return;
      }

      if (! safe(venue, object.Key)) {
        logger.error({ venue, key: object.Key }, 'Key outside the venue — skipped');

        continue;
      }

      const file: Haulable = {
        venue,
        key: object.Key,
        url: object.Url,
        ...(object.Size === undefined ? {} : { size: object.Size }),
        ...(object.ETag === undefined ? {} : { etag: object.ETag }),
      };

      const hauled = await haul(file);

      if (hauled.outcome === 'downloaded' || hauled.outcome === 'present') done.downloaded.push(object.Key);
      else if (hauled.outcome === 'failed') done.failed.push(object.Key);
      else if (hauled.outcome === 'unreached') unreached++;
      else done.mismatched.push({ Key: object.Key, ...(hauled.size === undefined ? {} : { Size: hauled.size }) });
    }
  };

  await Promise.all(Array.from({ length: config.concurrency }, worker));

  return { done, unreached, full };
};

/**
 * Whether the archives' volume is below the floor. Asked before every file,
 * and answered from the last look where that was under a second ago: files are
 * taken many at a time, and the volume does not move that fast.
 */
const low = async (): Promise<boolean> => {
  if (Date.now() - looked.at > LOOK_MS)
    looked = { at: Date.now(), low: await freeGb(config.archivesDir) < config.minFreeGb };

  return looked.low;
};

/** How long one look at the volume answers for. */
const LOOK_MS = 1_000;

let looked = { at: 0, low: false };

/** A key stays inside its venue's folder: under the venue asked for, and no step upward. */
const safe = (venue: string, key: string): boolean =>
  key.startsWith(`${venue}/`) && ! key.split('/').some(part => part === '' || part === '..' || part === '.');

// ── Test access ───────────────────────────────────────────────────────────────

export const _test_safe = safe;

/** Look at the volume afresh, where a test has just changed what counts as low. */
export const _test_lookAgain = (): void => { looked = { at: 0, low: false }; };
