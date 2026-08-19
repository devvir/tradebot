import type { Fault } from './types';

/**
 * What an error actually says, reduced to the part worth logging.
 *
 * **A stack trace of our own call path is not information.** Nearly everything
 * that fails here fails the same way — a socket that would not open, a host that
 * would not resolve, a connection the far end dropped — and the frames leading
 * to it are always `send → fetchText → page → sweep → walkOne`, whatever went
 * wrong. Twenty lines of that per failure buries the line that says *which venue
 * and which scope*, which is the only part anybody acts on.
 *
 * So a failure with a recognisable cause is logged as its cause, and the trace
 * is kept for failures that have none — where it is the only thing left that can
 * say anything.
 *
 * The cause is where the answer lives, and it is nested: `fetch` rejects with a
 * flat `TypeError: fetch failed` and hangs the real reason off `cause`, which for
 * a connect failure is an `AggregateError` holding one error per address it
 * tried. `tried` is that count — eight addresses timing out is a different
 * problem from one, and neither is visible in the message.
 */
export const fault = (err: unknown): Fault => {
  if (! (err instanceof Error)) return { error: String(err) };

  const message = err.message || err.name;
  const causes  = codesOf(err.cause);

  if (causes.length === 0)
    return {
      error: message,

      /**
       * **Trimmed, not dropped.** An error nothing here recognises is worth a
       * trace — that is the case a trace is for — but the frames that matter are
       * the ones nearest the throw, and the rest is the same path every time.
       */
      stack: err.stack?.split('\n').slice(1, FRAMES).map(line => line.trim()).join(' < '),
    };

  const tried = Array.isArray((err.cause as AggregateError | undefined)?.errors)
    ? (err.cause as AggregateError).errors.length
    : 1;

  return {
    error: message,
    cause: [...new Set(causes)].join(','),
    ...(tried > 1 ? { tried } : {}),
  };
};

/** The same thing as one string, for a log line that has no room for an object. */
export const faultLine = (err: unknown): string => {
  const seen = fault(err);

  return [seen.error, seen.cause, seen.tried ? `x${seen.tried}` : null]
    .filter(Boolean).join(' — ');
};

// ── Internals ─────────────────────────────────────────────────────────────────

/**
 * Every distinct reason behind an error, however deeply it is wrapped.
 *
 * A connect failure carries one error per address tried, and they are almost
 * always the same code — so they collapse to `ETIMEDOUT` rather than to eight
 * copies of it. An error with a cause but no code falls back to its name, which
 * is still better than a trace.
 */
const codesOf = (cause: unknown): string[] => {
  if (! (cause instanceof Error)) return [];

  const inner = (cause as AggregateError).errors;

  if (Array.isArray(inner))
    return inner.flatMap(one => codesOf(one).length > 0 ? codesOf(one) : [nameOf(one)]);

  return [nameOf(cause)];
};

const nameOf = (err: unknown): string => {
  const code = (err as { code?: string }).code;

  if (code) return code;

  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
};

/** How many frames of an unrecognised error are worth keeping. */
const FRAMES = 4;
