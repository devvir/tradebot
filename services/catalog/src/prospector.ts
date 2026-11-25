import config from './config';

/** What prospector answered: its status and its body. */
export interface Answer {
  status: number;
  body:   unknown;
}

/** How one call to prospector is made. */
export interface Sending {
  /** How long to wait for the answer; `config.prospectorMs` unless given. */
  timeoutMs?:  number;

  /**
   * Whether sending the request twice does what sending it once does. Every
   * method but `POST` is, unless told otherwise.
   */
  idempotent?: boolean;
}

/**
 * Hand prospector something to store, and give back what it answered.
 *
 * **Everything this service is sent to be stored goes this way**: prospector is
 * the only writer of the catalog database, so a write arriving here is its to
 * make. The answer is prospector's own — its status and its body — for the
 * caller to relay or to read. Throws where no answer came, or none in time.
 *
 * **A connection that fails is tried again, up to three attempts in all**,
 * with a short wait between: prospector closes idle keep-alive connections, so
 * a request now and then lands on one just as it goes. An idempotent request is
 * tried again on a connection refused, reset or closed; any other only on a
 * connection refused, which it certainly never reached prospector over. An answer is never retried
 * — a status is prospector's verdict — and neither is a call that timed out,
 * which prospector may still be carrying out.
 */
export const send = async (method: string, path: string, body?: unknown, sending: Sending = {}): Promise<Answer> => {
  const timeoutMs  = sending.timeoutMs ?? config.prospectorMs;
  const idempotent = sending.idempotent ?? method !== 'POST';

  for (let attempt = 1; ; attempt++) {
    try {
      const answer = await fetch(`${config.prospectorApi}${path}`, {
        method,
        headers: {
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(config.token ? { 'x-catalog-token': config.token } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });

      const text = await answer.text();

      return { status: answer.status, body: text === '' ? null : parsed(text) };
    } catch (err) {
      if (attempt >= ATTEMPTS || ! (idempotent ? DROPPED : UNSENT).has(codeOf(err))) throw err;

      await new Promise(done => setTimeout(done, config.retryMs * attempt));
    }
  }
};

// ── Internals ─────────────────────────────────────────────────────────────────

const ATTEMPTS = 3;

/** A connection that never reached prospector. */
const UNSENT = new Set(['ECONNREFUSED']);

/** A connection that failed before prospector answered: refused, reset or closed under the request. */
const DROPPED = new Set(['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET']);

/** The code of the connection failure under a failed fetch, if it was one. */
const codeOf = (err: unknown): string => String((err as { cause?: { code?: unknown } } | null)?.cause?.code ?? '');

/** An answer's body as JSON, or as the text it is where it is not. */
const parsed = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};
