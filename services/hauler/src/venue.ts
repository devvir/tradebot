import { logger } from '@devvir/service-kit';
import { page, report } from './catalog';
import { haul } from './fetch';
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
 */
export const walkVenue = async (venue: string, stopped: () => boolean): Promise<Walked> => {
  const walked: Walked = { listed: 0, progressed: 0, failed: 0, mismatched: 0 };

  let next: Promise<BucketPage> | null = page(venue, null);

  while (next) {
    const current: BucketPage = await next;
    const after   = current.IsTruncated ? current.NextMarker ?? current.Contents.at(-1)?.Key ?? null : null;

    next = after ? page(venue, after) : null;

    // Settled later, or abandoned when stopping; never left unhandled meanwhile.
    next?.catch(() => undefined);

    if (stopped()) return walked;

    const done = await workPage(venue, current, stopped);

    await report(venue, done);

    walked.listed     += current.Contents.length;
    walked.progressed += done.downloaded.length;
    walked.failed     += done.failed.length;
    walked.mismatched += done.mismatched.length;
  }

  return walked;
};

// ── Internals ─────────────────────────────────────────────────────────────────

/** One page's objects, `config.concurrency` at a time, taking no more once stopped. */
const workPage = async (venue: string, current: BucketPage, stopped: () => boolean): Promise<Report> => {
  const done: Report = { downloaded: [], failed: [], mismatched: [] };
  const queue = [...current.Contents];

  const worker = async (): Promise<void> => {
    for (let object = queue.shift(); object && ! stopped(); object = queue.shift()) {
      if (! safe(object.Key)) {
        logger.error({ venue, key: object.Key }, 'A key that would leave the archive — skipped');

        continue;
      }

      const file: Haulable = {
        venue,
        key: object.Key,
        url: `${current.BaseUrl}${object.Url}`,
        ...(object.Size === undefined ? {} : { size: object.Size }),
        ...(object.ETag === undefined ? {} : { etag: object.ETag }),
      };

      const hauled = await haul(file);

      if (hauled.outcome === 'downloaded' || hauled.outcome === 'present') done.downloaded.push(object.FileId);
      else if (hauled.outcome === 'failed') done.failed.push(object.FileId);
      else done.mismatched.push({ FileId: object.FileId, ...(hauled.size === undefined ? {} : { Size: hauled.size }) });
    }
  };

  await Promise.all(Array.from({ length: config.concurrency }, worker));

  return done;
};

/** A key stays inside the venue's folder: relative, and no step upward. */
const safe = (key: string): boolean =>
  key !== '' && ! key.startsWith('/') && ! key.split('/').some(part => part === '..' || part === '.');

// ── Test access ───────────────────────────────────────────────────────────────

export const _test_safe = safe;
