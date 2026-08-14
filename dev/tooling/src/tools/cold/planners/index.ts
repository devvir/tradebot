import { archives } from './archives';
import { vault } from './vault';
import type { Origin, Planner } from '../types';

/**
 * Which planner a tree gets.
 *
 * **This is the only place an origin means anything.** Packing, verifying,
 * queueing, confirming, reclaiming, the pacing and the resume rules are the
 * same operation whatever produced the files, so they take `origin` as a value
 * and never branch on it. A new collector is a planner and a row here.
 */
export const plannerFor = (origin: Origin): Planner => PLANNERS[origin];

// ── Internals ─────────────────────────────────────────────────────────────────

const PLANNERS: Record<Origin, Planner> = { vault, archives };
