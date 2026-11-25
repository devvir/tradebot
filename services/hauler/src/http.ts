import { request as plain } from 'node:http';
import { request as secure } from 'node:https';
import type { IncomingMessage } from 'node:http';

/**
 * Ask for a file, and answer the response as soon as it begins: its status and
 * headers, and its body as a stream not yet read.
 *
 * **The bytes as the server holds them.** It asks with
 * `accept-encoding: identity` and decodes nothing it is sent: an object stored
 * compressed, its `content-encoding` saying so, is that compressed object, and
 * that is the file.
 *
 * **Redirects are followed**, `REDIRECTS` of them at most, each to where its
 * `location` says; past that the redirect itself is the answer.
 *
 * **A connection not made within `CONNECT_MS` fails** — opened, and for
 * `https` its handshake done — as an address that drops what is sent to it
 * would otherwise hold the request for as long as the system keeps trying.
 * **A connection silent for `IDLE_MS` fails**, whether it is waiting for the
 * answer or for the next of its bytes. An aborted `signal` fails the request,
 * and the body where it is being read.
 */
export const get = async (url: string, signal: AbortSignal): Promise<IncomingMessage> => {
  let at = new URL(url);

  for (let followed = 0; ; followed++) {
    const res      = await once(at, signal);
    const location = res.headers.location;

    if (! MOVED.has(res.statusCode ?? 0) || ! location || followed === REDIRECTS) return res;

    res.resume();

    at = new URL(location, at);
  }
};

// ── Internals ─────────────────────────────────────────────────────────────────

const REDIRECTS = 5;

let CONNECT_MS = 10_000;

const IDLE_MS = 300_000;

const MOVED = new Set([301, 302, 303, 307, 308]);

const once = (url: URL, signal: AbortSignal): Promise<IncomingMessage> => new Promise((answered, failed) => {
  const send = url.protocol === 'https:' ? secure : plain;
  const req  = send(url, { headers: { 'accept-encoding': 'identity' }, signal }, answered);

  req.setTimeout(IDLE_MS, () =>
    req.destroy(Object.assign(new Error(`nothing for ${IDLE_MS / 1000}s`), { code: 'ETIMEDOUT' })));

  // A connection kept from an earlier request is made already; a new one is never made before it is handed over.
  req.once('socket', (socket) => {
    if (req.reusedSocket) return;

    const within = CONNECT_MS;
    const timer  = setTimeout(() =>
      req.destroy(Object.assign(new Error(`no connection in ${within / 1000}s`), { code: 'ETIMEDOUT' })), within);

    socket.once(url.protocol === 'https:' ? 'secureConnect' : 'connect', () => clearTimeout(timer));
    socket.once('close', () => clearTimeout(timer));
  });

  req.on('error', failed);
  req.end();
});

// ── Test access ───────────────────────────────────────────────────────────────

/** How long a connection is given to be made, where a test cannot wait ten seconds. */
export const _test_connectWithin = (ms: number): void => { CONNECT_MS = ms; };
