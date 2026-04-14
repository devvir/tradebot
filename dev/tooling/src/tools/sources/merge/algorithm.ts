import crypto from 'node:crypto';
import type { Message, MergeResult } from '../types';

/** Divergences that resolve within this window trigger a short-gap warning. */
const SHORT_GAP_THRESHOLD_MS = 1000;

/**
 * Merge two ordered streams of Messages using a two-pointer walk on the
 * canonical timestamp field.
 *
 * The canonical field is `timestamp` when `timestampCol` is set and the value
 * is present; otherwise `_date_`.
 *
 * Deduplication: a global `seen` set of content hashes ensures that any
 * message whose hash was already written is skipped, regardless of which file
 * it came from or what its canonical timestamp is. `_date_` is excluded from
 * the hash — it is local capture metadata, not part of the message content.
 *
 * Note on partials: partial messages are deduplicated by the same hash rule as
 * any other message. For tables with empty or fixed-content partials (e.g.
 * `connected`, most announcement-style tables), all but one occurrence will be
 * dropped. This is a deliberate trade-off: those partials carry no unique
 * content, so retaining duplicates adds noise without signal. The accepted
 * limitation is that we lose the ability to count reconnection events for those
 * tables.
 *
 * Throws if either file's canonical timestamps go backwards (corrupt timeline).
 * Warns if a divergence resolves in less than SHORT_GAP_THRESHOLD_MS.
 */
export async function mergeTable(
  aMessages:  AsyncIterable<Message>,
  bMessages:  AsyncIterable<Message>,
  write:      (msg: Message) => Promise<void>,
  options:    { timestampCol: string | null; fileLabels?: { a: string; b: string } },
): Promise<MergeResult> {
  const { timestampCol, fileLabels = { a: 'base', b: 'gaps' } } = options;

  const getCanonical = (msg: Message): string =>
    timestampCol && msg.timestamp ? msg.timestamp : msg.date;

  const warnings: string[] = [];
  let written = 0;

  /** Global dedup set — hashes of all messages written so far. */
  const seen = new Set<string>();

  const writeIfNew = async (msg: Message): Promise<void> => {
    const key = messageKey(msg);

    if (seen.has(key)) {
      return;
    }

    seen.add(key);
    await write(msg);
    written++;
  };

  const aIter = aMessages[Symbol.asyncIterator]();
  const bIter = bMessages[Symbol.asyncIterator]();

  let aNext = await aIter.next();
  let bNext = await bIter.next();

  let lastATs = '';
  let lastBTs = '';

  /** Timestamp at which the current divergence began; null when in sync. */
  let gapStart: string | null = null;

  // ── Main two-pointer loop ───────────────────────────────────────────────────

  while (! aNext.done && ! bNext.done) {
    const aTs = getCanonical(aNext.value);
    const bTs = getCanonical(bNext.value);

    checkMonotonicity(aTs, lastATs, fileLabels.a);
    checkMonotonicity(bTs, lastBTs, fileLabels.b);

    if (aTs === bTs) {
      if (gapStart !== null) {
        recordGapWarning(gapStart, aTs, warnings);
        gapStart = null;
      }

      await writeIfNew(aNext.value);
      lastATs = aTs;
      aNext = await aIter.next();

      await writeIfNew(bNext.value);
      lastBTs = bTs;
      bNext = await bIter.next();
    } else if (aTs < bTs) {
      if (gapStart === null) {
        gapStart = aTs;
      }

      await writeIfNew(aNext.value);
      lastATs = aTs;
      aNext = await aIter.next();
    } else {
      if (gapStart === null) {
        gapStart = bTs;
      }

      await writeIfNew(bNext.value);
      lastBTs = bTs;
      bNext = await bIter.next();
    }
  }

  // ── Drain remaining A messages ──────────────────────────────────────────────

  while (! aNext.done) {
    const aTs = getCanonical(aNext.value);

    checkMonotonicity(aTs, lastATs, fileLabels.a);
    await writeIfNew(aNext.value);
    lastATs = aTs;
    aNext = await aIter.next();
  }

  // ── Drain remaining B messages ──────────────────────────────────────────────

  while (! bNext.done) {
    const bTs = getCanonical(bNext.value);

    checkMonotonicity(bTs, lastBTs, fileLabels.b);
    await writeIfNew(bNext.value);
    lastBTs = bTs;
    bNext = await bIter.next();
  }

  return { written, warnings };
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Stable deduplication key for a message.
 * Key = "<action>|<sha256 over all rows with _date_ blanked>".
 *
 * `_date_` is blanked because it is a local capture timestamp that differs
 * between sources for the same underlying event. All other fields are hashed
 * in column-insertion order, which is stable across sources for the same table.
 */
function messageKey(msg: Message): string {
  const hash = crypto.createHash('sha256');

  for (const row of msg.rows) {
    for (const [col, val] of Object.entries(row)) {
      hash.update(col === '_date_' ? '' : (val ?? ''));
      hash.update('\x1f');
    }

    hash.update('\n');
  }

  return `${msg.action}|${hash.digest('hex')}`;
}

/**
 * Throw if `current` is strictly less than `previous` (backwards in time).
 * Empty strings are skipped — not all rows carry a canonical timestamp.
 */
function checkMonotonicity(current: string, previous: string, fileLabel: string): void {
  if (! current || ! previous) {
    return;
  }

  if (current < previous) {
    throw new Error(
      `Timestamp went backwards in ${fileLabel}:\n` +
      `  previous: ${previous}\n` +
      `  current:  ${current}\n` +
      `The timeline is corrupt. Run \`sources fix\` on the source file first, then retry the merge.`,
    );
  }
}

/**
 * Compute gap duration and push a warning if it is below the threshold.
 */
function recordGapWarning(gapStart: string, reSyncTs: string, warnings: string[]): void {
  try {
    const startMs    = new Date(gapStart).getTime();
    const endMs      = new Date(reSyncTs).getTime();
    const durationMs = endMs - startMs;

    if (durationMs < SHORT_GAP_THRESHOLD_MS) {
      warnings.push(
        `Short gap detected: ${gapStart} → ${reSyncTs} (${durationMs}ms). ` +
        `Expected gaps to be at least ${SHORT_GAP_THRESHOLD_MS}ms. ` +
        `Review whether the algorithm is correctly aligned.`,
      );
    }
  } catch {
    // Unparseable timestamp — skip the duration check.
  }
}

// ── Test exports ──────────────────────────────────────────────────────────────

export const _test_messageKey = messageKey;
