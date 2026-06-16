import { isoToMs } from '../time';
import type { Message } from '../types';
import type { PruneStats } from './types';

/**
 * Recency window: how many distinct content keys to remember while scanning
 * for duplicates. Implemented as two rotating sets, so at any moment between
 * `WINDOW` and `2 × WINDOW` keys are remembered. Ghost-sub duplicates arrive
 * within seconds of their original, so 500 k (≈ a couple of busy orderBookL2
 * minutes) is ample lookback while keeping memory bounded.
 */
const WINDOW = 500_000;

/**
 * Length threshold (bytes) for storing a content key literally vs. as a hash.
 *
 * A key at or under this length is kept verbatim — exact, collision-free and
 * cheap for the common case (single-row deltas). A longer key is replaced by a
 * compact hash, bounding per-entry memory: a reconnect-storm day's full-book
 * `orderBookL2` partials (tens of thousands of rows, multi-MB) would otherwise
 * fill the seen-set with multi-MB strings and exhaust the heap.
 *
 * The branch is purely length-based — `action` is never inspected. Partials and
 * other full-snapshot messages hash simply because they are large; nothing
 * special-cases them. 500 clears every single-row message of both deduped
 * tables (`orderBookL2` ~95–120 B, `instrument` (101 columns) ~135–225 B) plus
 * small multi-row messages, favouring cheap exact literal keys, and only the
 * genuinely large messages hash. It still caps the seen-set at a safe ~500 MB
 * (≤ 500 B × the 1M-entry window). Assumes single-byte content (no multi-byte
 * UTF-8), true for these numeric/ASCII CSV tables, so `String.length` is an
 * exact byte count.
 */
const MAX_LITERAL_KEY = 500;

/**
 * Filter a stream of `Message` batches, removing ghost-subscription duplicates
 * from interleaved parallel WS streams.
 *
 * A **monotonic clock** tracks the max `timestamp` seen so far. For each
 * message, if its content key has already been seen AND its `timestamp` is
 * more than `thresholdMs` behind the clock, it is dropped — the clock has
 * already moved past that point, so the message is arriving late from a
 * lagging parallel stream, not from a legitimate re-occurrence.
 *
 * Partials are deduped like any other message: a ghost-re-delivered partial is
 * a stale snapshot, and keeping it while the intervening deltas are dropped
 * would reset state to that stale snapshot — worse than the rare lost message.
 * A legitimate re-`partial` (reconnect) carries a fresh `timestamp`, so it has
 * a different content key and is kept.
 *
 * The seen-set is a **rotating pair of `Set`s**: keys go into `cur`; when it
 * fills to `windowSize`, `cur` becomes `prev` and a fresh `cur` starts. A key
 * is forgotten after it falls out of both sets (between `windowSize` and
 * `2 × windowSize` later keys). This bounds memory with no per-entry eviction —
 * the single-Map `keys().next()` eviction degrades badly once full, because
 * deleting the head leaves tombstones the iterator must scan past.
 *
 * `timestampIdx` is the column position of `timestamp` in the table's CSV
 * layout. It must be ≥ 0; callers derive it from `getVaultColumns`.
 */
export async function* prune(
  source:       AsyncGenerator<Message[]>,
  thresholdMs:  number,
  stats:        PruneStats,
  timestampIdx: number,
  windowSize:   number = WINDOW,
): AsyncGenerator<Message[]> {
  let cur   = new Set<string>();
  let prev  = new Set<string>();
  let clock = 0;

  for await (const batch of source) {
    const out: Message[] = [];

    for (const msg of batch) {
      const tsMs = extractTimestampMs(msg.rows[0]!, timestampIdx);

      if (! isNaN(tsMs) && tsMs > clock) clock = tsMs;

      const key  = contentKey(msg);
      const seen = cur.has(key) || prev.has(key);

      if (seen && ! isNaN(tsMs) && tsMs < clock - thresholdMs) {
        stats.dropped++;
        continue;
      }

      if (! seen) {
        // `flatten` only on the insert path: the lookup key above is transient
        // (GC'd after `.has`), so its slice may briefly pin a chunk with no
        // lasting cost; only the key that LIVES in the set must be detached.
        cur.add(flatten(key));

        if (cur.size >= windowSize) {
          prev = cur;
          cur  = new Set();
        }
      }

      stats.kept++;
      out.push(msg);
    }

    if (out.length > 0) yield out;
  }
}

function extractTimestampMs(row: string, timestampIdx: number): number {
  const fields = row.split(',', timestampIdx + 1);
  const ts     = fields[timestampIdx] ?? '';

  return ts ? isoToMs(ts) : NaN;
}

/**
 * Content key of a message, `_date_` stripped — the same BitMEX event produces
 * the same key regardless of reception time.
 *
 * The branch is chosen by **key length, not message type**: a short key (single
 * rows and small multi-row messages) is kept verbatim — exact and cheap; a long
 * key (partials, large multi-row messages) is replaced by a compact hash so the
 * seen-set never holds multi-MB strings. The decision is cheap to make without
 * materialising the join: a single-row length is `O(1)`, and a multi-row length
 * is the sum of row lengths (`O(rows)` — trivial even for a 22k-row partial, and
 * far cheaper than the char-level hash that follows). Because length is
 * deterministic from content, a message and any later duplicate always take the
 * same branch, so literal and hashed keys are never compared against each other.
 * A hash key (prefixed `\0`) can never equal a literal key (which starts on a
 * real CSV character), so the two key spaces stay disjoint.
 */
function contentKey(msg: Message): string {
  const first      = msg.rows[0]!;
  const firstComma = first.indexOf(',');

  if (msg.rows.length === 1) {
    return first.length - firstComma <= MAX_LITERAL_KEY ? first.slice(firstComma) : hashKey(msg);
  }

  let len = first.length - firstComma;

  for (let r = 1; r < msg.rows.length; r++) len += msg.rows[r]!.length + 1;

  return len <= MAX_LITERAL_KEY ? msg.rows.join('\n').slice(firstComma) : hashKey(msg);
}

/**
 * Force a standalone (flat) copy of a key before it enters the long-lived set.
 *
 * `String.prototype.slice` returns a V8 `SlicedString` that keeps its **whole
 * parent alive** — here the source CSV line, which readline itself hands back as
 * a substring of its multi-KB decode buffer. A literal key stored in the set
 * would therefore pin that entire buffer (and every other line in it — including
 * dropped duplicates) until the key is evicted. On a duplicate-heavy file the
 * ~1M live keys span ~16× more input, so they pin tens of thousands of distinct
 * buffers at once and the heap blows up even though the key *count* is bounded.
 * The Buffer round-trip copies the bytes into a fresh backing store with no
 * back-reference. Safe because keys are single-byte ASCII (same assumption as
 * `MAX_LITERAL_KEY`); an already-flat `hashKey` result is copied harmlessly.
 *
 * Called only on insert (≈ the kept fraction of messages), never on lookup.
 */
function flatten(key: string): string {
  return Buffer.from(key, 'latin1').toString('latin1');
}

/**
 * 64-bit hash (FNV-1a + djb2-xor) over a message's content — `rows[0]` from its
 * first comma onward, then each continuation row prefixed with `\n` — matching
 * what the joined literal key would cover, but computed incrementally so the
 * large snapshot string is never built.
 */
function hashKey(msg: Message): string {
  const first = msg.rows[0]!;
  const start = first.indexOf(',');

  let h1 = 0x811c9dc5; // FNV-1a offset basis
  let h2 = 5381;       // djb2

  for (let i = start < 0 ? 0 : start; i < first.length; i++) {
    const c = first.charCodeAt(i);

    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2, 33) ^ c;
  }

  for (let r = 1; r < msg.rows.length; r++) {
    h1 = Math.imul(h1 ^ 10, 0x01000193);
    h2 = Math.imul(h2, 33) ^ 10;

    const row = msg.rows[r]!;

    for (let i = 0; i < row.length; i++) {
      const c = row.charCodeAt(i);

      h1 = Math.imul(h1 ^ c, 0x01000193);
      h2 = Math.imul(h2, 33) ^ c;
    }
  }

  return `\x00${h1 >>> 0}.${h2 >>> 0}`;
}

// ── Test exports ──────────────────────────────────────────────────────────────

export const _test_extractTimestampMs = extractTimestampMs;
export const _test_contentKey         = contentKey;
