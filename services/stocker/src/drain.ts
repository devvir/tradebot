import { logger } from '@devvir/service-kit';

/** One sweep, told by `stop` when to start nothing more. */
export type Pass = (stop: AbortSignal) => Promise<void>;

/**
 * Sweeps on a timer, one at a time, until drained.
 *
 * Long-lived rather than a batch job, so files that land while nobody is
 * watching are picked up on its own. A tick that finds the last sweep still
 * running lets it be. A sweep that fails is logged, and the next tick sweeps
 * again.
 */
export class Scans {
  private readonly stop = new AbortController();
  private timer:   NodeJS.Timeout | null = null;
  private current: Promise<void> | null = null;

  constructor(private readonly everyMs: number) {}

  /** A sweep now, and then one every `everyMs` — none once drained. */
  async start(pass: Pass): Promise<void> {
    await this.pass(pass);

    if (! this.stop.signal.aborted) this.timer = setInterval(() => void this.pass(pass), this.everyMs);
  }

  /**
   * Start no other sweep, tell the one running to start nothing more, and wait
   * for it — for `boundMs` at most. True when nothing is left running.
   */
  async drain(boundMs: number): Promise<boolean> {
    this.stop.abort();

    if (this.timer) clearInterval(this.timer);

    if (! this.current) return true;

    let timeout: NodeJS.Timeout | undefined;

    const out = new Promise<false>(resolve => { timeout = setTimeout(() => resolve(false), boundMs); });

    try {
      return await Promise.race([this.current.then(() => true as const), out]);
    } finally {
      clearTimeout(timeout);
    }
  }

  private async pass(pass: Pass): Promise<void> {
    if (this.stop.signal.aborted) return;

    if (this.current) {
      logger.debug('Sweep still running — skipping this scan');

      return;
    }

    this.current = pass(this.stop.signal)
      .catch((err: unknown) => { logger.error({ err }, 'Sweep failed'); })
      .finally(() => { this.current = null; });

    await this.current;
  }
}

/** What is closed once the sweeps are drained. */
export interface Held {
  /** The engine's connections: closed only once nothing runs on them. */
  engine: () => void;

  /** The extraction threads. */
  pool:   () => Promise<void>;
}

/**
 * Shut down: drain the sweeps, then close what they held.
 *
 * The placements under way are given `boundMs` to finish. One that does not is
 * left as it is: the engine is not closed under it, the process exits with it,
 * and the next start puts right what it left — the ledger's `updating` line is
 * repaired, and its scratch cleared but for the pieces that were built.
 */
export const drain = async (scans: Scans, boundMs: number, held: Held): Promise<void> => {
  logger.info({ seconds: boundMs / 1000 }, 'Draining — starting nothing more, waiting for what is under way');

  const drained = await scans.drain(boundMs);

  if (drained) held.engine();
  else logger.warn({ seconds: boundMs / 1000 }, 'Drain ran out of time — exiting with a placement unfinished, put right on the next start');

  await held.pool();

  if (drained) logger.info('Drained');
};
