import { logger } from '@devvir/service-kit';
import type { VenueState } from './types';

/**
 * Per-venue politeness gate.
 *
 * Trucker's job is to pull tens of thousands of files from servers that owe us
 * nothing, so the guiding rule is: never be the reason a venue starts refusing.
 * Two mechanisms, both per venue so one venue's trouble never throttles another:
 *
 *   - a **minimum interval** between request starts, which bounds the rate even
 *     when every response is instant (a CDN cache hit returns in milliseconds,
 *     and unthrottled concurrency would turn that into a burst);
 *   - a **cooldown** that any rate-limit or authorisation response extends,
 *     backing the whole venue off rather than just the request that tripped it.
 *
 * The cooldown is deliberately venue-wide: a 429 means we are collectively too
 * fast, so slowing only the failing request would keep the pressure on.
 */

const MIN_INTERVAL_MS = 120;
const MAX_COOLDOWN_MS = 15 * 60 * 1000;

const state = new Map<string, VenueState>();

/** Wait until this venue may be called again. */
export const acquire = async (venue: string): Promise<void> => {
  const s = stateFor(venue);

  const now  = Date.now();
  const slot = Math.max(now, s.nextSlot, s.until);

  s.nextSlot = slot + MIN_INTERVAL_MS;

  if (slot > now) await sleep(slot - now);
};

/**
 * Record that a venue pushed back. Doubles its cooldown and parks every
 * subsequent request behind it. `retryAfterMs` from the response wins when the
 * venue told us how long to wait.
 */
export const penalise = (venue: string, reason: string, retryAfterMs?: number): void => {
  const s = stateFor(venue);

  s.cooldownMs = Math.min(s.cooldownMs === 0 ? 1_000 : s.cooldownMs * 2, MAX_COOLDOWN_MS);

  const waitMs = Math.max(retryAfterMs ?? 0, s.cooldownMs);

  s.until = Date.now() + waitMs;

  logger.warn({ venue, reason, waitMs }, 'Backing off venue');
};

/** A clean response: decay the cooldown so a venue recovers after trouble passes. */
export const reward = (venue: string): void => {
  const s = stateFor(venue);

  if (s.cooldownMs > 0) s.cooldownMs = Math.floor(s.cooldownMs / 2);
};

// ── Internals ─────────────────────────────────────────────────────────────────

const stateFor = (venue: string): VenueState => {
  const existing = state.get(venue);

  if (existing) return existing;

  const fresh: VenueState = { nextSlot: 0, cooldownMs: 0, until: 0 };

  state.set(venue, fresh);

  return fresh;
};

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

// ── Test access ───────────────────────────────────────────────────────────────

export const _test_reset = (): void => state.clear();
export const _test_state = state;
