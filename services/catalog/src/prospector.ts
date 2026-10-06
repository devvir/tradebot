import config from './config';

/**
 * Hand prospector something to store, and give back what it answered.
 *
 * **Everything this service is sent to be stored goes this way**: prospector is
 * the only writer of the catalog database, so a write arriving here is its to
 * make. The answer is prospector's own — its status and its body — for the
 * caller to relay or to read.
 *
 * **A connection that fails is tried again**, three times with a short wait
 * between: prospector closes idle keep-alive connections, so a request now and
 * then lands on one just as it goes (`ECONNRESET`). An answer is never retried —
 * a status is prospector's verdict.
 */
export const send = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown }> => {
  for (let attempt = 1; ; attempt++) {
    try {
      const answer = await fetch(`${config.prospectorApi}${path}`, {
        method,
        headers: {
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(config.token ? { 'x-catalog-token': config.token } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });

      const text = await answer.text();

      return { status: answer.status, body: text === '' ? null : parsed(text) };
    } catch (err) {
      if (attempt >= ATTEMPTS) throw err;

      await new Promise(done => setTimeout(done, RETRY_MS * attempt));
    }
  }
};

// ── Internals ─────────────────────────────────────────────────────────────────

const ATTEMPTS = 3;
const RETRY_MS = 500;

/** An answer's body as JSON, or as the text it is where it is not. */
const parsed = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};
