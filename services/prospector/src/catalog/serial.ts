/**
 * The queue every synchronous write waits in.
 *
 * **A budget per caller is not a budget.** Slicing one `putFiles` to 20ms bounds
 * that call and nothing else: node runs the whole immediate queue in one turn, so
 * every partition that happens to be mid-write takes its 20ms in the *same* turn.
 * With the partitions this service runs in parallel that is seconds of
 * uninterrupted synchronous SQLite before a timer or a socket is looked at again.
 *
 * Measured on the running service before this existed: event-loop delay of 477ms
 * at the median and **3.5 seconds** at the peak, with 61% of all CPU inside
 * `node:sqlite` and 92% of that inside `putFiles`. The visible symptom was logs
 * arriving in bursts with long silences between them — nothing could flush.
 *
 * So the slices are serialised and separated: one runs, the loop is handed back,
 * the next runs. Delay becomes one slice rather than however many writers exist,
 * and **nothing is lost by it** — SQLite serialises writes on one connection
 * regardless, so the interleaving was never buying concurrency. What it was
 * buying was the fetches, the timers and the logging that run in between.
 */
export const slice = <T>(work: () => T): Promise<T> => {
  const mine = queue.then(async () => {
    const out = work();

    // Between slices, always — this is the yield the whole arrangement is for.
    await new Promise(resolve => setImmediate(resolve));

    return out;
  });

  queue = mine.then(() => undefined, () => undefined);

  return mine;
};

let queue: Promise<void> = Promise.resolve();


/**
 * How long one slice may hold the loop.
 *
 * The bound is on the *pause*, not on the number of rows behind it — what
 * matters is how long anything else waits, and a row's cost varies with the
 * table it lands in.
 */
export const BREATH_MS = 20;
