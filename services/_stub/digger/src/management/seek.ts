import * as clock from '../core/clock';
import * as snapshot from '../core/snapshot';
import type { Reader } from '../reader';
import type { WsRuntime } from '../ws';

/**
 * The seek — a flat sequence of **idempotent orders**: pause the loop, let any
 * in-flight emit settle, clear buffers, reset the accumulator, set the clock, then
 * re-prime. Each order is a no-op when it doesn't apply (nothing running → pause
 * does nothing; no buffers → clear does nothing), so this never branches on what
 * is running. Priming isn't a step — it's `reprime` re-activating each subscribed
 * table at the new clock and resending partials, using the reader's standing
 * "empty buffer → activate" path.
 */

const SETTLE_MS = 50;

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

export const setClock = async (ms: number, ws: WsRuntime, reader: Reader): Promise<void> => {
  ws.loop.paused = true;

  await sleep(SETTLE_MS);

  reader.clear();
  snapshot.reset();
  clock.set(ms);

  await ws.hub.reprime();

  ws.loop.paused = false;
};
