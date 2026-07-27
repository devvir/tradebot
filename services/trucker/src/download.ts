import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { basename } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { logger } from '@devvir/service-kit';
import { acquire, penalise, reward } from './limiter';
import { commit, discard, exists, pathFor, writePartial } from './store';
import { venueFor } from './venues';
import type { ArchiveFile, DownloadResult, Verdict } from './types';

const ATTEMPTS = 5;

/** Probes an "absent" must agree on, for the venues whose 404s have lied. */
const ABSENT_CONFIRMATIONS = 2;
const BASE_MS  = 1_000;
const MAX_MS   = 60_000;

/**
 * Fetch one archive file to disk.
 *
 * `absent` (404) is a normal outcome, not a failure: the venues that construct
 * URLs are asked for dates that may never have been published, and the trailing
 * edge of every venue is unpublished until it is.
 */
export const download = async (
  venue:   string,
  dataset: string,
  file:    ArchiveFile,
): Promise<DownloadResult> => {
  const absolute = pathFor(venue, file.path);

  if (await exists(absolute)) {
    logger.debug({ venue, dataset, file: file.path }, 'Already on disk');

    return { status: 'skipped', bytes: 0 };
  }

  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    await acquire(venue);

    try {
      const res = await fetch(file.url);

      if (res.ok) {
        if (! res.body) throw new Error('empty body');

        // Everything lands and is verified as a `.part` file; only `commit`
        // gives it the final name. Verifying after the rename would leave a
        // truncated or corrupt file at the real path when verification failed —
        // where `exists` skips it on every later sweep, permanently.
        const bytes    = await writePartial(absolute, res.body);
        const declared = Number(res.headers.get('content-length'));

        // Three of five venues publish no checksum, so a response truncated by
        // an early close would otherwise be accepted as complete and skipped
        // forever. Comparing the declared length catches it — unless the
        // response was transfer-encoded, where undici decodes the body and the
        // declared length describes the encoded bytes, not what was written.
        const encoded = res.headers.get('content-encoding') !== null;

        if (! encoded && Number.isFinite(declared) && declared > 0 && declared !== bytes) {
          await discard(absolute);

          throw new Error(`truncated: got ${bytes} of ${declared} bytes`);
        }

        if (! await verify(venue, `${absolute}.part`, file)) {
          await discard(absolute);

          throw new Error('checksum mismatch');
        }

        await commit(absolute);

        reward(venue);

        logger.info({ venue, dataset, symbol: file.symbol, mb: round(bytes / 1e6) },
          `Downloaded ${basename(file.path)}`);

        return { status: 'downloaded', bytes };
      }

      const archive = venueFor(venue);

      // A venue override reads the error body as well as the status — Bitget's
      // "does not exist" and a genuine block are both 403, distinguishable only
      // by the body. Error bodies are a few hundred bytes, so reading one costs
      // nothing; it is skipped entirely for venues without an override.
      const body    = archive.classify ? await res.text().catch(() => '') : '';
      const verdict = archive.classify?.(res.status, body) ?? classify(res.status);

      // "Absent" is how a venue says a period was never published, and for the
      // venues that construct URLs it is the expected answer for most requests.
      // It is taken at face value — except on a venue whose absences have been
      // caught lying, where it is probed again before being believed, since the
      // cursor steps past a believed absence for good.
      if (verdict === 'absent') {
        if (archive.unreliableAbsence && attempt < ABSENT_CONFIRMATIONS) {
          await sleep(delayFor(attempt));

          continue;
        }

        logger.debug({ venue, dataset, url: file.url }, 'Not published');

        return { status: 'absent', bytes: 0 };
      }

      logger.warn({ venue, dataset, status: res.status, verdict, url: file.url }, 'Non-2xx response');

      if (verdict === 'backoff')
        penalise(venue, `HTTP ${res.status}`, retryAfterMs(res.headers.get('retry-after')));

      if (attempt === ATTEMPTS) return { status: 'failed', bytes: 0 };

      await sleep(delayFor(attempt));
    } catch (err) {
      await discard(absolute);

      if (attempt === ATTEMPTS) {
        logger.error({ err, venue, dataset, url: file.url }, 'Download failed');

        return { status: 'failed', bytes: 0 };
      }

      await sleep(delayFor(attempt));
    }
  }

  return { status: 'failed', bytes: 0 };
};

/**
 * The default reading of a status. Most venues answer 404 for a missing file
 * *and* a missing symbol, so 404 is trustworthy as "not published" — but not
 * all of them do, which is what `Venue.classify` is for.
 *
 * Everything else is treated as our problem, not theirs:
 *   - 429 means slow down; 403 too, since that is how a CDN usually expresses a
 *     block and none of these venues use it for a missing key
 *   - 5xx is transient by definition, and S3-fronted hosts also answer 503
 *     ("SlowDown") under load
 *   - any other 4xx is retried a few times and reported; we have no model for
 *     it, and guessing is how a client gets banned
 */
export const classify = (status: number): Verdict => {
  if (status === 404) return 'absent';
  if (status === 429) return 'backoff';
  if (status === 403) return 'backoff';
  if (status >= 500)  return 'backoff';

  return 'retry';
};

// ── Internals ─────────────────────────────────────────────────────────────────

/** Attempts the small checksum companion gets before the file is accepted unverified. */
const CHECKSUM_ATTEMPTS = 3;

/**
 * Checksum companions differ by venue: Binance publishes SHA-256, KuCoin MD5.
 * Neither says which, so the digest length decides — and an unrecognised length
 * leaves the file unverified rather than rejected, since the wrong algorithm
 * would discard perfectly good data.
 *
 * The companion fetch goes through the same per-venue limiter as everything
 * else — it is a request to the venue like any other — and a companion that
 * cannot be fetched leaves the file **unverified rather than failed**: throwing
 * here would discard a perfectly good multi-hundred-MB download over a flaky
 * 63-byte side request.
 */
const verify = async (venue: string, partial: string, file: ArchiveFile): Promise<boolean> => {
  if (! file.checksumUrl) return true;

  const expected = await checksumFor(venue, file) ?? undefined;
  const algo     = algorithmFor(expected);

  if (! expected || ! algo) return true;

  const actual = await hashFile(partial, algo);

  if (actual !== expected)
    logger.warn({ file: file.path, algo, expected, actual }, 'Checksum mismatch');

  return actual === expected;
};

/** The published digest, or `null` when none can be had this time. */
const checksumFor = async (venue: string, file: ArchiveFile): Promise<string | null> => {
  for (let attempt = 1; attempt <= CHECKSUM_ATTEMPTS; attempt++) {
    await acquire(venue);

    try {
      const res = await fetch(file.checksumUrl!);

      if (res.ok) return (await res.text()).trim().split(/\s+/)[0]?.toLowerCase() ?? null;

      if (res.status === 404) return null;   // no checksum published after all

      if (classify(res.status) === 'backoff')
        penalise(venue, `HTTP ${res.status} on checksum`, retryAfterMs(res.headers.get('retry-after')));
    } catch (err) {
      logger.debug({ err, url: file.checksumUrl }, 'Checksum fetch failed');
    }

    if (attempt < CHECKSUM_ATTEMPTS) await sleep(delayFor(attempt));
  }

  logger.warn({ url: file.checksumUrl }, 'Checksum unavailable — accepting the file unverified');

  return null;
};

/**
 * Hash from disk as a stream. Reading the whole archive into memory to hash it
 * would hold several files of hundreds of MB at once across the venue pools.
 */
const hashFile = async (path: string, algo: 'md5' | 'sha256'): Promise<string> => {
  const hash = createHash(algo);

  await pipeline(createReadStream(path), hash);

  return hash.digest('hex');
};

const algorithmFor = (digest: string | undefined): 'md5' | 'sha256' | null => {
  if (digest?.length === 32) return 'md5';
  if (digest?.length === 64) return 'sha256';

  return null;
};

/** Exponential with full jitter — synchronised retries across workers are their own hazard. */
const delayFor = (attempt: number): number => {
  const ceiling = Math.min(BASE_MS * 2 ** (attempt - 1), MAX_MS);

  return Math.floor(Math.random() * ceiling);
};

const retryAfterMs = (header: string | null): number | undefined => {
  if (! header) return undefined;

  const seconds = Number(header);

  if (Number.isFinite(seconds)) return seconds * 1_000;

  const date = Date.parse(header);

  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
};

const round = (n: number): number => Math.round(n * 10) / 10;

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

// ── Test access ───────────────────────────────────────────────────────────────

export const _test_algorithmFor = algorithmFor;
export const _test_retryAfterMs = retryAfterMs;
