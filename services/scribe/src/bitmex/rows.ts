import { logger } from '@devvir/service-kit';
import { sleep } from '../utils';
import { recordFetch, record429 } from './metrics';
import { pickIdentity, reportRemaining, pace } from './identities';
import { MAX_IN_FLIGHT, acquireSlot, releaseSlot } from './pool';
import type { Row, FetchFilter } from './types';

const DEFAULT_PAGE_SIZE = 500;

// Returns the first matching row, or null.
export const fetchOne = async (
  baseUrl: string,
  path:    string,
  filter:  FetchFilter = {},
): Promise<Row | null> => {
  const url  = buildUrl(baseUrl, path, 0, 1, filter);
  const rows = await fetchWithRetry(url);

  return rows[0] ?? null;
};

// Streams rows from the BitMEX API, handling pagination and block transitions
// transparently. The caller sees a flat sequence of rows with no page boundaries.
//
// Within a startTime-block, pages are fetched through a bounded ring (see
// streamBlock): up to MAX_IN_FLIGHT requests run concurrently, but never more
// than MAX_IN_FLIGHT ahead of the oldest one not yet flushed, so output stays in
// strict offset order. A block ends when a short/empty page arrives or the
// `maxStart` offset cap is reached; we then reanchor `blockStartTime` to the last
// row's tsField and start a fresh block at offset 0, until the data is exhausted.
export async function* rowIterator(
  baseUrl:  string,
  path:     string,
  maxStart: number | null,
  tsField:  string | undefined,
  filter:   FetchFilter = {},
): AsyncGenerator<Row> {
  const pageSize = filter.count ?? DEFAULT_PAGE_SIZE;

  let blockStartTime = filter.startTime ?? null;

  while (true) {
    const next = yield* streamBlock(baseUrl, path, maxStart, tsField, pageSize, blockStartTime, filter);

    if (next === null) return; // data exhausted

    blockStartTime = next;
  }
}

// ── Private ───────────────────────────────────────────────────────────────────

/**
 * Streams one startTime-block in strict offset order through a bounded ring of
 * MAX_IN_FLIGHT concurrent fetches, and returns the next `blockStartTime` to
 * reanchor to — or `null` when the data is exhausted.
 *
 * The ring is the whole trick: each turn we `await` the *oldest* outstanding
 * request (the one with the most time to have finished — usually already
 * resolved), flush it, then launch the next offset into its freed slot. So we
 * stay ~MAX_IN_FLIGHT in flight without ever waiting on a whole batch at once,
 * and because slots are filled and drained in the same order, flushing is FIFO —
 * byte-identical to a sequential fetch. Launches stop at the `maxStart` offset
 * cap so we never speculatively fetch past it.
 *
 * A block ends on the first short/empty page (window exhausted) or when the cap
 * is hit. If we made progress, we reanchor to the last row's tsField (the `+1ms`
 * no-progress safeguard lives in `reanchor`); otherwise the data is done. Any
 * look-ahead still in flight past that point is abandoned by returning — fetching
 * a few extra pages is cheap, and dropping them keeps the output ordered.
 */
async function* streamBlock(
  baseUrl:        string,
  path:           string,
  maxStart:       number | null,
  tsField:        string | undefined,
  pageSize:       number,
  blockStartTime: string | null,
  filter:         FetchFilter,
): AsyncGenerator<Row, string | null> {
  const ring: (Promise<Row[]> | null)[] = new Array(MAX_IN_FLIGHT).fill(null);

  let launchOffset = 0;
  let progressed   = false;
  let lastTs:      string | undefined;

  const launch = (slot: number): void => {
    if (maxStart !== null && launchOffset > maxStart) {
      ring[slot] = null; // past the offset cap — stop launching; the empty slot ends the block

      return;
    }

    const url = buildUrl(
      baseUrl, path, launchOffset, pageSize,
      { ...filter, startTime: blockStartTime ?? undefined },
    );

    ring[slot]    = fetchWithRetry(url);
    launchOffset += pageSize;
  };

  try {
    for (let s = 0; s < MAX_IN_FLIGHT; s++) launch(s);

    // The block ends here if we saw data (reanchor for the next window) or not (done).
    const endOfBlock = (): string | null => (progressed && lastTs ? reanchor(blockStartTime, lastTs) : null);

    for (let index = 0; ; index++) {
      const slot    = index % MAX_IN_FLIGHT;
      const pending = ring[slot];

      if (pending === null) return endOfBlock(); // drained up to the offset cap

      const rows = await pending;
      ring[slot] = null;

      if (rows.length === 0) return endOfBlock(); // empty page in order — window exhausted

      for (const row of rows) yield row;

      const ts = pickTime(rows[rows.length - 1]!, tsField);
      if (ts) lastTs = ts;

      if (rows.length < pageSize) return endOfBlock(); // short page — window exhausted

      progressed = true;
      launch(slot); // full page — top the ring back up
    }
  } finally {
    // Whatever look-ahead is still in flight when the block ends — or when the
    // consumer stops early — is abandoned by design. Swallow each pending
    // settlement so a late socket error on a page nobody will await can't
    // surface as an unhandled rejection and crash the process.
    for (const pending of ring) pending?.catch(() => {});
  }
}

/**
 * Reads the field BitMEX sorts and filters startTime on for this table, so the
 * pagination math uses the same clock as the filter. `logged` (insertion time)
 * for tables that set `tsField`; `timestamp` (falling back to `date`) otherwise.
 */
const pickTime = (row: Row, tsField: string | undefined): string | undefined =>
  (tsField ? row[tsField] : (row['timestamp'] ?? row['date'])) as string | undefined;

/**
 * Picks the next blockStartTime for a transition.
 *
 * Normally the block advances to the last row's tsField value. When that value
 * does not move strictly past the current anchor, the batch made no forward
 * progress: every row shared one tsField instant (e.g. a backfill burst all
 * inserted at the same `logged`), so re-anchoring to it would re-fetch the
 * identical window forever. The rows are already yielded; step the anchor one
 * millisecond forward. startTime is millisecond-exact on tsField, so +1ms clears
 * the instant in a single step; any rows sharing it beyond the offset cap are
 * unreachable and dropped — unavoidable and bounded.
 */
const reanchor = (current: string | null, lastTs: string): string => {
  if (current === null || lastTs > current) return lastTs;

  return addMs(current, 1);
};

const addMs = (iso: string, ms: number): string =>
  new Date(new Date(iso).getTime() + ms).toISOString();

const buildUrl = (
  baseUrl: string,
  path:    string,
  start:   number,
  count:   number,
  filter:  FetchFilter,
): string => {
  const params = new URLSearchParams({
    start:   String(start),
    count:   String(count),
    reverse: String(filter.reverse ?? false),
  });

  if (filter.symbol)    params.set('symbol',    filter.symbol);
  if (filter.startTime) params.set('startTime', filter.startTime);
  if (filter.endTime)   params.set('endTime',   filter.endTime);
  if (filter.filter)    params.set('filter',    JSON.stringify(filter.filter));

  return `${baseUrl}${path}?${params}`;
};

const fetchWithRetry = async (url: string): Promise<Row[]> => {
  while (true) {
    await acquireSlot(); // take a slot from the service-wide pool before hitting BitMEX

    try {
      const identity = await pickIdentity();
      const t0       = Date.now();

      let res: Response;

      try {
        res = await identity.client.request(url);
      } catch (err) {
        logger.warn({ err, url }, 'Request failed — retrying in 3s');
        await sleep(3_000);
        continue;
      }

      reportRemaining(identity, res);

      if (res.ok) {
        recordFetch(Date.now() - t0); // 2xx consumed a token — counts even if this page is later discarded

        let rows: Row[];

        // The socket can drop mid-body even after a 2xx header (undici
        // UND_ERR_SOCKET / "terminated") — the partial response is unusable.
        // The client only retries the header phase, so guard the body read here
        // and treat a failed read like any transient request failure: re-fetch.
        try {
          rows = (await res.json()) as Row[];
        } catch (err) {
          logger.warn({ err, url }, 'Response body read failed — retrying in 3s');
          await sleep(3_000);
          continue;
        }

        // Hold the slot THROUGH pace(): an occupied slot is the throttle. Releasing
        // before pacing would hand the slot to another table's waiter, which fires
        // immediately — so with ≥2 active tables the pool would admit at full
        // concurrency regardless of pace() and overshoot the budget into 429s.
        await pace();

        return rows;
      }

      if (res.status === 429) {
        // Bucket exhausted (already zeroed by reportRemaining). pace() backs off
        // only if *every* bucket is dry; otherwise it returns ~0 and the re-pick
        // routes straight to a bucket that still has budget.
        record429();
        logger.warn({ identity: identity.name, url }, 'Rate limited (429) — routing to another identity');
        await pace();
        continue;
      }

      logger.warn({ status: res.status, url }, 'HTTP error — retrying in 3s');
      await sleep(3_000);
    } finally {
      releaseSlot(); // released only after pacing/parsing/backoff — see the pace() note above
    }
  }
};

// ── Test access ───────────────────────────────────────────────────────────────

export const _test_MAX_IN_FLIGHT = MAX_IN_FLIGHT;
