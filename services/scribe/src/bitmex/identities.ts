import { createHmac } from 'node:crypto';
import { registry, logger } from '@devvir/service-kit';
import type { FetchClientHandle } from '@devvir/service-kit';
import config from '../config';
import { sleep } from '../utils';
import type { Credential, Identity } from './types';

/**
 * BitMEX rate-limits guest (anonymous) requests per IP at 180/min and
 * authenticated requests per account at 120/min — independent, continuously
 * refilling buckets. Running them in parallel multiplies throughput: each
 * request goes out as the identity with the most headroom, and every response's
 * `x-ratelimit-remaining` reconciles that identity's budget, so the streams
 * self-balance to their refill rates. Each identity is backed by an SK fetch
 * client (retries, timeout, reachability, and HMAC signing for free). A 429 is
 * handled here rather than retried on the same client: the exhausted bucket is
 * zeroed and the picker routes to another, so one drained identity never stalls
 * the rest. Adding accounts to SCRIBE_IDENTITIES adds 120/min lanes with no other
 * change. See docs/services/SCRIBE.md.
 */

const GUEST_SEED      = 180;
const AUTH_SEED       = 120;
const WATERLINE       = 100;  // throttle starts once the *combined* budget across all identities falls below this
const PACE_MS         = 500; // graduated wait, in ms, per unit of combined budget below the waterline
const REFILL_WINDOW_S = 60;  // BitMEX buckets refill their full limit over one minute
const RETRY_ON        = [502, 503, 504]; // 429 is handled by the picker (route around it), not retried on the same bucket
const VALIDATE_PATH   = '/instrument/compositeIndex?symbol=.BXBT&count=1';

let identities: Identity[] = [];
let ready: Promise<void> | null = null;

/**
 * Returns the identity with the most rate-limit headroom for the next request and
 * optimistically decrements its budget — counting the about-to-happen fetch right
 * away so back-to-back picks (the ring's look-ahead) fan out across buckets
 * instead of stacking on the current fullest. It's only an estimate; the next
 * response re-anchors `remaining` to the real header value. Picking the fullest
 * bucket is the whole routing strategy: a drained identity is skipped, and a 429
 * (handled in the fetch loop) zeroes its bucket so the picker moves off it at
 * once. No throttle here — backpressure is in `pace`. Built lazily.
 */
export const pickIdentity = async (): Promise<Identity> => {
  await (ready ??= init());

  const id = bestOf(identities);

  id.remaining -= 1;

  return id;
};

/**
 * Post-response throttle. Waits only when *every* identity has fallen below the
 * waterline — while any bucket still has budget the picker routes to it, so no
 * wait is needed and the pipe stays full. The wait is graduated by how far the
 * fullest bucket has sunk, so the streams self-pace to their combined refill rate
 * and each bucket oscillates just under the waterline: never pinned at its cap
 * (which would waste refill), rarely drained to zero. Called per worker, never as
 * a shared stop, so requests keep flowing throughout — that overlap is what holds
 * throughput at the buckets' combined refill rate.
 */
export const pace = async (): Promise<void> => {
  const ms = paceMs(identities);

  if (ms > 0) await sleep(ms);
};

/** Reconciles an identity's budget from a response (HTTP 429 means exhausted). */
export const reportRemaining = (identity: Identity, res: Response): void => {
  if (res.status === 429) {
    identity.remaining = 0;
    identity.updatedAt = Date.now();
    return;
  }

  const raw = res.headers.get('x-ratelimit-remaining');
  const n   = raw === null ? null : parseInt(raw, 10);

  if (n !== null && Number.isFinite(n)) {
    identity.remaining = n;
    identity.updatedAt = Date.now();
  }
};

/** Per-identity budget estimate as a compact `name:remaining,…` string for the metrics log. */
export const budgets = (): string =>
  identities.map(i => `${i.name}:${Math.round(i.remaining)}`).join(',');

/** Estimated current budget: the last reported value plus the refill accrued since, capped at the limit. */
const available = (id: Identity): number =>
  Math.min(id.limit, id.remaining + ((Date.now() - id.updatedAt) / 1_000) * (id.limit / REFILL_WINDOW_S));

/** The identity with the most estimated budget right now. */
const bestOf = (ids: Identity[]): Identity =>
  ids.reduce((a, b) => (available(b) > available(a) ? b : a));

/** Combined estimated budget across every identity right now. */
const totalAvailable = (ids: Identity[]): number =>
  ids.reduce((sum, id) => sum + available(id), 0);

/**
 * Graduated backpressure on the *combined* budget: zero while the identities
 * together still hold more than the waterline, growing as the pool drains.
 * Routing pools the budget (each request goes to whichever bucket has the most),
 * so the total is what matters — three buckets at 30/25/25 are 85 of headroom and
 * keep fetching, even though no single one is high. Only when the whole pool runs
 * dry does every worker pause, which is the one legitimate reason to stop: the
 * rate limit itself.
 */
const paceMs = (ids: Identity[]): number =>
  Math.max(0, WATERLINE - totalAvailable(ids)) * PACE_MS;

// ── Private ───────────────────────────────────────────────────────────────────

/** Builds every identity's fetch client and drops any account BitMEX rejects (401/403). */
const init = async (): Promise<void> => {
  const now = Date.now();

  identities = [
    { name: 'guest', credential: null, limit: GUEST_SEED, remaining: GUEST_SEED, updatedAt: now, client: makeClient('guest', null) },
    ...parseCredentials().map((credential, i): Identity => ({
      name:      `acct${i + 1}`,
      credential,
      limit:     AUTH_SEED,
      remaining: AUTH_SEED,
      updatedAt: now,
      client:    makeClient(`acct${i + 1}`, credential),
    })),
  ];

  const ok = await Promise.all(identities.map(async (identity) => {
    if (! identity.credential) return true; // guest needs no validation

    try {
      const res = await identity.client.request(`${config.bitmexRestUrl}${VALIDATE_PATH}`);

      if (res.status === 401 || res.status === 403) {
        logger.warn({ name: identity.name }, 'Identity rejected by BitMEX — dropping');
        return false;
      }

      return true;
    } catch (err) {
      logger.warn({ name: identity.name, err }, 'Identity check failed (transient) — keeping');
      return true;
    }
  }));

  identities = identities.filter((_, i) => ok[i]);

  logger.info({ identities: identities.map(i => i.name) }, 'Identities ready');
};

const makeClient = (name: string, credential: Credential | null): FetchClientHandle =>
  registry.get('scribe').clients.create({
    type:    'fetch',
    name:    `bitmex-${name}`,
    retryOn: RETRY_ON,
    ...(credential ? { sign: makeSign(credential) } : {}),
  }) as FetchClientHandle;

const makeSign = (credential: Credential) =>
  ({ method, url, body }: { method: string; url: string; body: string }): Record<string, string> =>
    signRequest(credential, method, url, body);

/** BitMEX HMAC: hex(sha256(secret, verb + path + expires + body)); expires is unix seconds. */
function signRequest(credential: Credential, method: string, url: string, body: string): Record<string, string> {
  const { pathname, search } = new URL(url);
  const expires   = Math.floor(Date.now() / 1_000) + 60;
  const signature = createHmac('sha256', credential.apiSecret)
    .update(`${method}${pathname}${search}${expires}${body}`)
    .digest('hex');

  return {
    'api-key':       credential.apiKey,
    'api-expires':   String(expires),
    'api-signature': signature,
  };
}

/** Parses SCRIBE_IDENTITIES (`apiKey:apiSecret,...`). Read here, not in config, so secrets never reach the logged config. */
function parseCredentials(): Credential[] {
  return (process.env.SCRIBE_IDENTITIES ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map((pair) => {
      const sep = pair.indexOf(':');

      if (sep < 1 || sep === pair.length - 1)
        throw new Error('SCRIBE_IDENTITIES entries must be apiKey:apiSecret');

      return { apiKey: pair.slice(0, sep), apiSecret: pair.slice(sep + 1) };
    });
}

// ── Test access ───────────────────────────────────────────────────────────────

export const _test_signRequest = signRequest;
export const _test_available   = available;
export const _test_paceMs      = paceMs;
export const _test_WATERLINE   = WATERLINE;
export const _test_PACE_MS     = PACE_MS;
