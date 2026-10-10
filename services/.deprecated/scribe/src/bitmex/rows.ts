import { logger } from '@devvir/service-kit';
import { sleep } from '../utils';
import { recordFetch, record429 } from './metrics';
import { pickIdentity, reportRemaining, pace } from './identities';
import { MAX_IN_FLIGHT, acquireSlot, releaseSlot } from './pool';
import type { Row, FetchFilter } from './types';
import type { TableConfig } from '../types';

const ALLOWED_MAX_START = 10000;
const DEFAULT_PAGE_SIZE = 500;

// Returns the first matching row, or null.
export const fetchOne = async (
  baseUrl: string,
  table:   TableConfig,
  filter:  FetchFilter = {},
): Promise<Row | null> => {
  const url  = buildUrl(baseUrl, table, 0, 1, filter);
  const rows = await fetchWithRetry(url);

  return rows[0] ?? null;
};

// Streams rows from the BitMEX API, handling pagination and block transitions
// transparently. The caller sees a flat sequence of rows with no page boundaries
// and no block-boundary duplicates.
//
// Within a startTime-block, pages are fetched through a bounded ring (see
// streamBlock): up to MAX_IN_FLIGHT requests run concurrently, but never more
// than MAX_IN_FLIGHT ahead of the oldest one not yet flushed, so output stays in
// strict offset order. A block ends when a short/empty page arrives or the
// `maxStart` offset cap is reached; we then reanchor `blockStartTime` to the last
// row's tsField and start a fresh block at offset 0, until the data is exhausted.
//
// **Boundary hold:** the trailing run of rows at the stream's current max
// tsField instant is held back, not emitted. A strictly newer instant proves the
// run complete and flushes it; exhaustion flushes it. When a block ends *on* the
// held instant, the reanchored window re-delivers every row at that instant from
// offset 0 (startTime is inclusive) — the held copies are dropped and the fresh
// ones re-buffered, so the boundary rows are emitted exactly once instead of
// twice. When the reanchor steps past the instant (the +1ms no-progress skip),
// the next window will NOT re-deliver, so the run is flushed instead.
export async function* rowIterator(
  baseUrl: string,
  table:   TableConfig,
  filter:  FetchFilter = {},
): AsyncGenerator<Row> {
  const pageSize = filter.count ?? DEFAULT_PAGE_SIZE;
  const tsField  = table.tsField;

  let blockStartTime = filter.startTime ?? null;

  // BitMEX support recommended using a lower maxStart despite what the API allows
  const maxStart = table.maxStart ? Math.min(table.maxStart, ALLOWED_MAX_START) : null;

  let held:   Row[]         = [];
  let heldTs: string | null = null;

  while (true) {
    const block = streamBlock(baseUrl, table, maxStart, pageSize, blockStartTime, filter);

    let next: string | null = null;

    // Drive the block manually (instead of `yield*`) so each row passes through
    // the boundary hold. The finally closes the block if the consumer stops us
    // mid-yield, so its ring of in-flight look-ahead is always cleaned up.
    try {
      while (true) {
        const r = await block.next();

        if (r.done) {
          next = r.value;
          break;
        }

        const row = r.value;
        const ts  = pickTime(row, tsField);

        if (! ts) {
          // No sort-field value: the row can't be placed on the clock. Emit in
          // place when nothing is held; otherwise keep it inside the held run
          // so output order is preserved.
          if (held.length === 0) yield row;
          else held.push(row);

          continue;
        }

        if (heldTs !== null && ts > heldTs) {
          // Strictly newer instant — the held run is provably complete.
          yield* held.splice(0);
        }

        // Equal instants extend the run; an older ts can't happen (the stream
        // is monotonic in the sort field) but would be kept too — never lost.
        if (heldTs === null || ts > heldTs) heldTs = ts;

        held.push(row);
      }
    } finally {
      await block.return(null);
    }

    if (next === null) {
      // Data exhausted — the held run is final.
      yield* held;

      return;
    }

    if (heldTs !== null && next > heldTs) {
      // The +1ms no-progress skip: the next window starts strictly past the
      // held instant and will not re-deliver it — flush now or lose the rows.
      yield* held.splice(0);
      heldTs = null;
    } else if (heldTs !== null) {
      // next === heldTs: the reanchored window re-delivers every row at the
      // held instant from offset 0. Drop the held copies; the fresh ones are
      // re-buffered as they arrive, so the boundary is emitted exactly once.
      held   = [];
      heldTs = null;
    }

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
  table:          TableConfig,
  maxStart:       number | null,
  pageSize:       number,
  blockStartTime: string | null,
  filter:         FetchFilter,
): AsyncGenerator<Row, string | null> {
  const ring: (Promise<Row[]> | null)[] = new Array(MAX_IN_FLIGHT).fill(null);

  const tsField = table.tsField;

  let launchOffset = 0;
  let progressed   = false;
  let lastTs:      string | undefined;

  const launch = (slot: number): void => {
    if (maxStart !== null && launchOffset > maxStart) {
      ring[slot] = null; // past the offset cap — stop launching; the empty slot ends the block

      return;
    }

    const url = buildUrl(
      baseUrl, table, launchOffset, pageSize,
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
  table:   TableConfig,
  start:   number,
  count:   number,
  filter:  FetchFilter,
): string => {
  const params = new URLSearchParams({
    start:   String(start),
    count:   String(count),
    reverse: String(filter.reverse ?? false),
  });

  // The table's static params (e.g. binSize) go in first, so a filter key can
  // never be silently shadowed by one of them.
  for (const [key, value] of Object.entries(table.params ?? {})) params.set(key, value);

  if (filter.symbol)    params.set('symbol',    filter.symbol);
  if (filter.startTime) params.set('startTime', filter.startTime);
  if (filter.endTime)   params.set('endTime',   filter.endTime);
  if (filter.filter)    params.set('filter',    JSON.stringify(filter.filter));

  return `${baseUrl}${table.path}?${params}`;
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
