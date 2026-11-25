// Served by the root entry, and as `@tradebot/utils/retry`, which loads this module alone.

/**
 * How a wait is spread around its exponential value `d`:
 *   - `'full'`: anywhere in `[0, d)`, so callers retrying together do not wake together
 *   - `'none'`: exactly `d`
 *   - a fraction `f` in `[0, 1]`: anywhere in `[d·(1−f), d·(1+f)]`, never above `maxMs`
 */
export type Jitter = 'full' | 'none' | number;

/** An exponential back-off: `baseMs` after the first failure, doubling after each further one. */
export interface Backoff {
  /** The exponential value after the first failure, before jitter. */
  baseMs: number;
  /** The longest wait, jitter included. Unbounded when absent. */
  maxMs?: number;
  /** How the wait is spread around its exponential value (default `'full'`). */
  jitter?: Jitter;
}

export interface RetryOptions extends Backoff {
  /** How many times `fn` is called at most, the first call included; an integer of at least 1. */
  attempts: number;
  /** Ends the retries: no further attempt starts, a pending wait ends, and `retry` rejects with the signal's reason. */
  signal?: AbortSignal;
  /** Whether a failure is worth another attempt (default: every failure is). `attempt` is the call that failed, from 1. */
  shouldRetry?: (err: unknown, attempt: number) => boolean;
  /** Called before each wait with the failure, the attempt that failed, and the wait in milliseconds. */
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
}

/**
 * The wait, in whole milliseconds, after `attempt` consecutive failures (from 1): `baseMs · 2^(attempt−1)`,
 * capped at `maxMs`, then spread by `jitter`.
 */
export const backoffDelay = (attempt: number, { baseMs, maxMs = Infinity, jitter = 'full' }: Backoff): number => {
  const exponential = Math.min(baseMs * 2 ** (Math.max(attempt, 1) - 1), maxMs);

  if (jitter === 'full') return Math.floor(Math.random() * exponential);
  if (jitter === 'none') return Math.round(exponential);

  if (! (jitter >= 0 && jitter <= 1)) throw new RangeError(`jitter must be 'full', 'none' or a fraction in [0, 1], not ${jitter}`);

  return Math.min(Math.round(exponential * (1 - jitter + 2 * jitter * Math.random())), maxMs);
};

/**
 * Call `fn` until it resolves, at most `attempts` times, waiting `backoffDelay` between calls.
 * Resolves with the first result. Rejects with the last failure once the attempts are spent, or
 * at once with a failure `shouldRetry` declines. `fn` is given the attempt number, from 1, and
 * `signal`, so it can abandon work in flight.
 */
export const retry = async <T>(
  fn: (attempt: number, signal?: AbortSignal) => Promise<T>,
  options: RetryOptions,
): Promise<T> => {
  const { attempts, signal, shouldRetry = () => true, onRetry } = options;

  if (! Number.isInteger(attempts) || attempts < 1) throw new RangeError(`attempts must be an integer of at least 1, not ${attempts}`);

  for (let attempt = 1; ; attempt++) {
    signal?.throwIfAborted();

    try {
      return await fn(attempt, signal);
    } catch (err) {
      signal?.throwIfAborted();

      if (attempt >= attempts || ! shouldRetry(err, attempt)) throw err;

      const delayMs = backoffDelay(attempt, options);

      onRetry?.(err, attempt, delayMs);
      await wait(delayMs, signal);
    }
  }
};

// ── Internals ─────────────────────────────────────────────────────────────────

/** Sleep `ms`, or until `signal` aborts, rejecting then with its reason. */
const wait = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);

    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    signal?.addEventListener('abort', onAbort, { once: true });
  });
