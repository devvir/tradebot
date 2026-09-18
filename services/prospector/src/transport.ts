import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { logger } from '@devvir/service-kit';
import { deliver } from './deliver';
import { fault } from './faults';
import type { Carried, Fault, Lane, PageRead, Receipt } from './types';

/**
 * Every request this service sends, carried off the main thread.
 *
 * **Why.** One thread decides what to ask, writes what comes back to the
 * catalog, and — without this — also runs every socket, every TLS record and
 * every megabyte of listing. Measured 2026-09-30 with every venue backfilling:
 * that thread at 96% or more, a fifth of it on the transfer side. SQLite has to
 * stay where it is, since its transactions belong to one connection on one
 * thread; a request is a question in and an answer out, with nothing shared, so
 * it is the part that moves.
 *
 * **Only the transfer moves.** Pacing, retries, what a status means and whether
 * a venue is blocking us stay in `http.ts` on the main thread, because they are
 * decisions that read and change state every venue shares. See `deliver`.
 *
 * **In-process until `openTransport` is called.** The code that runs is the
 * same either way; the service opens workers at start, and anything that never
 * does — a test, a one-off tool — carries its requests itself.
 */
export const carry = (url: string, read: PageRead | null): Promise<Carried> => {
  if (lanes.length === 0) return deliver(url, read);

  const id   = ++lastId;
  const lane = lanes[id % lanes.length]!;

  return new Promise((resolve, reject) => {
    lane.waiting.set(id, { resolve, reject });
    lane.outbox.push({ id, url, read });

    schedule(lane);
  });
};

/**
 * Start carrying requests, on as many workers as `concurrency` — the
 * machine-wide ceiling on requests in flight — calls for, sharing `connections`
 * between them.
 */
export const openTransport = (concurrency: number, connections: number): void => {
  const workers = workersFor(concurrency);

  share = Math.max(1, Math.floor(connections / workers));

  for (let i = 0; i < workers; i++) lanes.push(lane());

  logger.info({ workers, concurrency, connections, connectionsEach: share }, 'Transport open');
};

// ── Internals ─────────────────────────────────────────────────────────────────

/**
 * One worker per `IN_FLIGHT_PER_WORKER` requests the machine may have in flight.
 *
 * **What loads a worker is requests a second, and in flight is what sets
 * that**: a probe takes ~0.25–0.3 s, so 1,000 in flight is ~3,300–4,000 a
 * second. Measured 2026-09-30, one worker carried ~2,300 a second alongside
 * every other venue's walk on under half a core — so 1,000 each leaves it
 * around half a core, and raising the ceiling brings the workers to carry it.
 * More than needed only splits the connection pools for nothing.
 */
const workersFor = (concurrency: number): number =>
  Math.max(1, Math.ceil(concurrency / IN_FLIGHT_PER_WORKER));

const IN_FLIGHT_PER_WORKER = 1_000;

const lanes: Lane[] = [];

/** Each worker's part of the machine's connections — see `Config.connections`. */
let share = Infinity;

let lastId = 0;

const lane = (): Lane => {
  const it: Lane = {
    worker:    new Worker(join(__dirname, 'transport.worker.js'), { workerData: { connections: share } }),
    waiting:   new Map(),
    outbox:    [],
    scheduled: false,
  };

  it.worker.unref();

  it.worker.on('message', (receipts: Receipt[]) => {
    for (const { id, carried, fault: why } of receipts) {
      const waiting = it.waiting.get(id);

      if (! waiting) continue;

      it.waiting.delete(id);

      if (carried) waiting.resolve(carried);
      else waiting.reject(rebuilt(why!));
    }
  });

  it.worker.on('error', err => logger.error({ ...fault(err) }, 'Transport worker failed'));

  /**
   * **A worker that dies is replaced, and what it held is failed.** Every
   * request in it fails as a transport error does, which is the case `http.ts`
   * already retries; nothing waits on an answer that will never come.
   */
  it.worker.on('exit', code => {
    const lost = it.waiting.size;

    for (const waiting of it.waiting.values()) waiting.reject(new Error('Transport worker exited'));

    it.waiting.clear();

    const at = lanes.indexOf(it);

    if (at === -1) return;

    logger.error({ code, lost }, 'Transport worker exited; starting another');

    lanes[at] = lane();
  });

  return it;
};

/**
 * Send what has queued up as soon as the task that queued it ends.
 *
 * **Batched, because a message is not free**: requests decided together cross
 * together, one structured clone and one wake-up for all of them.
 *
 * **But never held for the next turn of the loop.** On a thread this busy a
 * turn is long, and a request waiting for it waits that long before it has even
 * left. Measured 2026-09-30 with the batch sent from `setImmediate`: probes
 * spent 41 ms at the median in the worker and 136 ms end to end.
 */
const schedule = (lane: Lane): void => {
  if (lane.scheduled) return;

  lane.scheduled = true;

  queueMicrotask(() => {
    lane.scheduled = false;

    const parcels = lane.outbox;

    lane.outbox = [];
    lane.worker.postMessage(parcels);
  });
};

/**
 * A worker's failure as an error again, reading the same in a log as the one it
 * was made from — see `faultLine`.
 */
const rebuilt = (fault: Fault): Error => {
  const err = new Error(fault.error);

  if (fault.cause) err.cause = Object.assign(new Error(fault.cause), { code: fault.cause });

  return err;
};

// ── Test access ───────────────────────────────────────────────────────────────

export const _test_rebuilt = rebuilt;
export const _test_workersFor = workersFor;
