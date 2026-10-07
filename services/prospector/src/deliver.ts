import { Agent as HttpAgent, request as httpRequest } from 'node:http';
import { constants as h2, connect } from 'node:http2';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { connect as tlsConnect } from 'node:tls';
import { readPage } from './scanners/pages';
import type { Carried, Carrier, PageRead } from './types';

/**
 * One request, sent and read to its end.
 *
 * **Transfer only.** Whether to send it, how fast, what a status means and
 * whether to try again are all decided by the caller in `http.ts`; this is the
 * part that costs CPU — sockets, TLS, and reading a body that runs to megabytes
 * — and nothing else, which is what lets it run on a thread of its own. See
 * `transport.ts`.
 *
 * **A probe without `read`, a listing with it.** A listing's page is read here,
 * as it lands, so what goes back to the caller is the reading — see `pages.ts`.
 *
 * **It resolves when the transfer is over**, not when the reply starts: a
 * listing that succeeded comes back with its page read, and any other reply
 * with its body thrown away. So whoever holds a slot for it holds it for
 * exactly as long as the venue is sending.
 */
export const deliver = (url: string, read: PageRead | null): Promise<Carried> =>
  read ? get(url, read) : head(url);

// ── Internals ─────────────────────────────────────────────────────────────────

/** A listing answers in about a second; anything not replying by now is wedged. */
let ANSWER_MS = 15_000;


/**
 * How long a reply already in flight may go quiet.
 *
 * Separate from `ANSWER_MS` because it measures a different thing: not how long
 * the whole transfer takes, which is a fact about its size, but how long it goes
 * without progressing, which is the only evidence that it never will.
 *
 * **Deliberately close to the floor.** A body under load arrives a chunk per turn
 * of the event loop, so this has to clear the loop's own lag or it fires on a
 * healthy transfer — and a false stall costs a whole re-request, which against a
 * megabyte of listing is how a timeout turns into a rate limit. The lag it has
 * to clear is a second or so, and the worst gap ever measured here was three, so
 * ten is several times the headroom needed and still fails loudly enough to be
 * the first sign that this machine is oversubscribed.
 */
const STALL_MS = 10_000;

/**
 * A `GET`, through `fetch`.
 *
 * **The deadline is on the answer, and silence is on the body.** `fetch`
 * resolves at the headers, so a deadline around it asks the only question a
 * deadline can answer: did the venue reply. Left running over the body it asks
 * whether the reply finished in time, which is a question about size and never a
 * fault — a listing page runs to megabytes and is entitled to take as long as it
 * takes. The body is held to silence instead, the clock restarting on every
 * chunk.
 */
const get = async (url: string, read: PageRead): Promise<Carried> => {
  const control = new AbortController();
  const answer  = setTimeout(() => control.abort(unanswered()), ANSWER_MS);

  const sent = performance.now();

  let res: Response;

  try {
    res = await fetch(url, { signal: control.signal });
  } finally {
    clearTimeout(answer);
  }

  const answered = performance.now();
  const headers  = Object.fromEntries(res.headers);

  if (! res.ok) {
    // Nobody reads a refusal's body, and it is not over until it is dropped.
    await res.body?.cancel().catch(() => {});

    return { status: res.status, headers, page: null };
  }

  const text    = await readAll(res, control);
  const arrived = performance.now();
  const page    = readPage(read, text);

  return {
    status: res.status, headers, page,
    timing: { firstByte: answered - sent, body: arrived - answered, parse: performance.now() - arrived },
  };
};

/**
 * A body read to its end, failing on `STALL_MS` of silence.
 *
 * **Failing on the read itself rather than through the abort**: an aborted
 * `fetch` does not reliably settle, and a listing nobody is ever answered about
 * parks a partition for the life of the process.
 */
const readAll = async (res: Response, control: AbortController): Promise<string> => {
  if (! res.body) return '';

  const reader  = res.body.getReader();
  const decoder = new TextDecoder();

  let text = '';

  for (;;) {
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
      const step = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(stalled()), STALL_MS);
        }),
      ]);

      if (step.done) return text + decoder.decode();

      text += decoder.decode(step.value, { stream: true });
    } catch (err) {
      control.abort();
      void reader.cancel().catch(() => {});

      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
};

/** What a venue that never answered is reported as — the deadline by name, not a bare abort. */
const unanswered = (): Error =>
  Object.assign(new Error(`No answer within ${ANSWER_MS / 1000}s`), { name: 'TimeoutError' });

const stalled = (): Error =>
  Object.assign(new Error(`Response body went silent for ${STALL_MS}ms`), { name: 'StallTimeoutError' });

/**
 * A `HEAD`, over HTTP/2 wherever the host speaks it.
 *
 * **Because a probe for a missing file cost a connection.** Node's HTTP/1.1
 * client does not keep a connection after a `HEAD` reply that states neither a
 * length nor chunking, and that is how bitget, kucoin and bybit's second host
 * answer for a key they do not have — the answer an update gets most. Measured
 * 2026-09-30 on bitget: 1,000 such probes opened 1,000 connections, and at 250
 * in flight the service held 9,000 sockets closing and a probe took 285–907 ms
 * at the median, most of it a TLS handshake. Over HTTP/2 a probe is a stream
 * on a connection that stays: the same missing keys answered in 235 ms at 250
 * in flight, which is the venue's own time to say no.
 *
 * **HTTP/1.1 otherwise**, over a kept connection — S3's own endpoints do not
 * offer HTTP/2 — and never through `fetch`, which does not reuse a connection
 * after a `HEAD` at all (measured 2026-09-29: ~800 ms a probe against one
 * round trip's ~270).
 */
const head = async (url: string): Promise<Carried> => {
  if (! url.startsWith('https:') || ! await speaksH2(new URL(url).origin)) return headOverH1(url);

  /**
   * **A refused stream is asked again at once**, on another connection. HTTP/2
   * guarantees the server did nothing with it — it is what a connection being
   * wound down answers — so it is neither a failure nor a request the venue
   * saw, and the retry ladder in `http.ts` would only add a wait.
   */
  try {
    return await headOverH2(url);
  } catch (err) {
    if (! refused(err)) throw err;

    return headOverH2(url);
  }
};

const refused = (err: unknown): boolean =>
  err instanceof Error && err.message.includes('NGHTTP2_REFUSED_STREAM');

const headOverH1 = (url: string): Promise<Carried> =>
  new Promise((resolve, reject) => {
    const secure  = url.startsWith('https:');
    const issue   = secure ? httpsRequest : httpRequest;
    const control = new AbortController();
    const answer  = setTimeout(() => control.abort(unanswered()), ANSWER_MS);

    const req = issue(url, { method: 'HEAD', agent: secure ? KEEP_HTTPS : KEEP_HTTP, signal: control.signal }, res => {
      clearTimeout(answer);
      res.resume();

      resolve({ status: res.statusCode ?? 0, headers: plain(res.headers), page: null });
    });

    req.on('error', err => {
      clearTimeout(answer);

      // An abort carries why it aborted; that is the error worth reporting.
      reject(err.name === 'AbortError' && err.cause instanceof Error ? err.cause : err);
    });

    req.end();
  });

/**
 * One pool per protocol. How many are in use at once is `wired`'s to say.
 *
 * **Idle ones are kept, all of them.** By default an agent keeps 256 idle
 * connections per host and destroys the rest, and a host given 600 at once
 * passes 256 idle between any two requests — so connections were torn down
 * only to be opened again, each paying a TLS handshake on this thread. A
 * handshake is the expensive part of a request here: measured 2026-10-01 on
 * loopback, with no network at all, 3,000 lanes opening connections at once
 * missed their deadlines by the hundred and reopened them by the thousand.
 * The venue closes a connection it no longer wants.
 */
const KEEP_HTTPS = new HttpsAgent({ keepAlive: true, maxFreeSockets: Infinity });
const KEEP_HTTP  = new HttpAgent({ keepAlive: true, maxFreeSockets: Infinity });

/**
 * One stream, settled when it closes: with the reply it got, or with why it got
 * none.
 */
const headOverH2 = (url: string): Promise<Carried> =>
  new Promise((resolve, reject) => {
    const { origin, pathname, search } = new URL(url);
    const carrier = carrierFor(origin);
    const stream  = carrier.session.request({ ':method': 'HEAD', ':path': pathname + search }, { endStream: true });

    carrier.open++;

    let carried: Carried | null = null;
    let over = false;

    const finish = (): void => {
      if (over) return;

      over = true;
      carrier.open--;
      clearTimeout(answer);

      // Nothing new goes on a retired connection, so the last stream off it is the end of it.
      if (carrier.retired && carrier.open === 0 && ! carrier.session.destroyed) carrier.session.destroy();
    };

    /**
     * **A stream nobody answered takes its connection out of use.** A
     * connection can die without either end being told, and every stream sent
     * on it afterwards waits out the deadline and fails — so one left in the
     * pool fails every probe given to it, for as long as the service runs. The
     * next probe opens another. A healthy connection that was merely slow once
     * costs a handshake.
     */
    const answer = setTimeout(() => {
      carrier.retired = true;

      stream.close(h2.NGHTTP2_CANCEL);
      finish();
      reject(unanswered());
    }, ANSWER_MS);

    stream.on('response', headers => {
      carried = { status: Number(headers[':status']), headers: plain(headers), page: null };
    });

    stream.on('error', err => {
      finish();

      // A connection refusing streams is being wound down: nothing more goes on it.
      if (refused(err)) carrier.retired = true;

      reject(err);
    });

    stream.on('close', () => {
      finish();

      if (carried) resolve(carried);
      else reject(new Error(`Stream closed without a reply (code ${stream.rstCode})`));
    });

    stream.resume();
  });

/**
 * A connection to `origin` with room for one more stream, opening one when none
 * has.
 *
 * **Several, not one.** A server caps the streams one connection carries —
 * CloudFront at 128 — and a venue may be asked many more at once than that.
 * A connection the server ends or loses leaves the pool, and what was in
 * flight on it fails as any transport error does.
 */
const carrierFor = (origin: string): Carrier => {
  const pool = CARRIERS.get(origin) ?? [];

  CARRIERS.set(origin, pool);

  const free = pool.find(one => one.open < STREAMS && ! one.retired && ! one.session.closed && ! one.session.destroyed);

  if (free) return free;

  const carrier: Carrier = { session: connect(origin), open: 0, retired: false };

  const drop = (): void => {
    const at = pool.indexOf(carrier);

    if (at !== -1) pool.splice(at, 1);
  };

  carrier.session.on('goaway', drop);
  carrier.session.on('close', drop);
  carrier.session.on('error', drop);
  carrier.session.unref();

  pool.push(carrier);

  return carrier;
};

/** Streams one connection is given before another is opened: under CloudFront's 128. */
const STREAMS = 100;

const CARRIERS = new Map<string, Carrier[]>();

/**
 * Whether a host offers HTTP/2, asked once per host by the TLS handshake itself.
 *
 * A host that could not be asked is taken as HTTP/1.1 for this request and asked
 * again on the next, so an outage at the wrong moment does not decide it for
 * good.
 */
const speaksH2 = (origin: string): Promise<boolean> => {
  let known = PROTOCOLS.get(origin);

  if (! known) {
    known = negotiated(origin).then(protocol => protocol === 'h2', () => {
      PROTOCOLS.delete(origin);

      return false;
    });

    PROTOCOLS.set(origin, known);
  }

  return known;
};

const PROTOCOLS = new Map<string, Promise<boolean>>();

const negotiated = (origin: string): Promise<string | false | null> =>
  new Promise((resolve, reject) => {
    const { hostname, port } = new URL(origin);

    const socket = tlsConnect(
      { host: hostname, port: Number(port || 443), servername: hostname, ALPNProtocols: ['h2', 'http/1.1'] },
      () => {
        resolve(socket.alpnProtocol);
        socket.destroy();
      },
    );

    socket.setTimeout(ANSWER_MS, () => socket.destroy(new Error(`No TLS handshake from ${origin}`)));
    socket.on('error', reject);
  });

/** Headers as a plain record: pseudo-headers dropped, repeated ones joined. */
const plain = (raw: Record<string, string | string[] | number | undefined>): Record<string, string> => {
  const headers: Record<string, string> = {};

  for (const [name, value] of Object.entries(raw))
    if (value !== undefined && ! name.startsWith(':'))
      headers[name] = Array.isArray(value) ? value.join(', ') : String(value);

  return headers;
};

// ── Test access ───────────────────────────────────────────────────────────────

export const _test_readAll = readAll;

/** The answer deadline, for a test that cannot wait it out; null puts it back. */
export const _test_answerWithin = (ms: number | null): void => { ANSWER_MS = ms ?? 15_000; };
