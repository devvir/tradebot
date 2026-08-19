/**
 * Run `work` over `items`, at most `limit` in flight.
 *
 * One item throwing neither abandons its lane nor goes unmentioned. Both halves
 * matter and they pull against each other: swallowing an error keeps the lanes
 * running but lets a survey report success with a partition unread, while
 * letting it propagate surfaces it and leaves the remaining lanes running
 * detached behind a rejected `Promise.all`.
 *
 * So failures are collected and raised together once every lane has drained.
 * A caller that wants to handle a failure per item — as `surveyVenue` does,
 * because it knows which partition it was — catches inside `work` and this never
 * fires.
 */
export const pool = async <T>(
  items: readonly T[],
  limit: number,
  work:  (item: T) => Promise<void>,
): Promise<void> => {
  const queue  = [...items];
  const failed: unknown[] = [];

  const lanes = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      try {
        await work(next);
      } catch (err) {
        failed.push(err);
      }
    }
  });

  await Promise.all(lanes);

  if (failed.length > 0)
    throw new AggregateError(failed, `${failed.length} of ${items.length} items failed`);
};

// ── Test access ───────────────────────────────────────────────────────────────

export const _test_pool = pool;
