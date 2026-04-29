import type { Message, MergeResult } from '../types';

/**
 * Merge N ordered streams of Messages using an N-way walk on the canonical
 * timestamp field.
 *
 * The canonical field is `timestamp` when `timestampCol` is set and the value
 * is present in the message; otherwise `_date_`.
 *
 * Algorithm — one-source-per-timestamp, partials take precedence:
 *   1. Find the minimum canonical timestamp `minTs` across all stream heads.
 *   2. Pick the winner stream:
 *      - When `timestampCol` is set and any head at `minTs` is a `partial`,
 *        the lowest-index such stream wins (partials are the full source of
 *        truth — preferred over deltas that may have started mid-stream).
 *      - Otherwise the lowest-index stream at `minTs` wins (alphabetical
 *        priority).
 *   3. Write every message from the winner at `minTs`.
 *   4. Advance every other stream past `minTs`, discarding those messages —
 *      even if a non-winner happens to hold a partial there.
 *
 * Exactly one source contributes data at any given canonical timestamp. This
 * fills gaps cleanly: if source A is missing ts=T, source B (the next in
 * priority) provides it. Content is never compared — same-timestamp messages
 * in non-winner sources are always skipped, which is correct because gaps are
 * coarse (seconds to minutes), not sub-millisecond.
 *
 * Assumes each source is already sorted by canonical timestamp (post `fix`).
 * Throws if any stream's canonical timestamps go backwards.
 */
export async function mergeTable(
  streams:  AsyncIterable<Message>[],
  write:    (msg: Message) => Promise<void>,
  options:  { timestampCol: string | null; fileLabels?: string[] },
): Promise<MergeResult> {
  const { timestampCol, fileLabels = [] } = options;

  const labelFor = (i: number): string => fileLabels[i] ?? `stream-${i}`;

  const getCanonical = (msg: Message): string =>
    timestampCol && msg.timestamp ? msg.timestamp : msg.date;

  let written = 0;
  const sourceCounts = new Array<number>(streams.length).fill(0);

  // ── Initialise one iterator per stream ─────────────────────────────────────

  const iterators = streams.map(s => s[Symbol.asyncIterator]());
  const heads: Array<{ msg: Message; ts: string } | null> = [];
  const lastTs: string[] = new Array(streams.length).fill('');

  for (const iter of iterators) {
    const next = await iter.next();
    heads.push(next.done ? null : { msg: next.value, ts: getCanonical(next.value) });
  }

  const advance = async (i: number): Promise<void> => {
    const next = await iterators[i].next();
    heads[i] = next.done ? null : { msg: next.value, ts: getCanonical(next.value) };
  };

  // ── N-way walk ─────────────────────────────────────────────────────────────

  while (true) {
    // Find the minimum canonical timestamp across all active heads.
    let minTs: string | null = null;

    for (const head of heads) {
      if (head !== null && (minTs === null || head.ts < minTs)) {
        minTs = head.ts;
      }
    }

    if (minTs === null) {
      break; // all streams exhausted
    }

    // Pick the winner. Partials take precedence over alphabetical order, but
    // only when the canonical field is `timestamp` — small tables (canonical
    // = `_date_`) follow plain first-source-wins. Source order is the
    // tiebreaker among heads of the same kind.
    let winnerIdx = -1;

    if (timestampCol) {
      for (let i = 0; i < heads.length; i++) {
        if (heads[i] !== null && heads[i]!.ts === minTs && heads[i]!.msg.action === 'partial') {
          winnerIdx = i;
          break;
        }
      }
    }

    if (winnerIdx === -1) {
      for (let i = 0; i < heads.length; i++) {
        if (heads[i] !== null && heads[i]!.ts === minTs) {
          winnerIdx = i;
          break;
        }
      }
    }

    // Write all winner messages at minTs.
    while (heads[winnerIdx] !== null && heads[winnerIdx]!.ts === minTs) {
      const { msg, ts } = heads[winnerIdx]!;

      checkMonotonicity(ts, lastTs[winnerIdx]!, labelFor(winnerIdx));
      await write(msg);
      written++;
      sourceCounts[winnerIdx]++;
      lastTs[winnerIdx] = ts;
      await advance(winnerIdx);
    }

    // Advance all non-winner streams past minTs — their messages at this
    // timestamp are owned by the winner.
    for (let i = 0; i < heads.length; i++) {
      if (i === winnerIdx) {
        continue;
      }

      while (heads[i] !== null && heads[i]!.ts === minTs) {
        checkMonotonicity(heads[i]!.ts, lastTs[i]!, labelFor(i));
        lastTs[i] = heads[i]!.ts;
        await advance(i);
      }
    }
  }

  return { written, warnings: [], sourceCounts };
}

// ── Internal helpers ──────────────────────────────────────────────────────────

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
