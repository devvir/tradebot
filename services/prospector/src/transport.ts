import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { logger } from '@devvir/service-kit';
import { deliver } from './deliver';
import { fault } from './faults';
import type { Carried, Fault, Lane, PageRead, Receipt, Slot } from './types';

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
 * **In-process whenever no worker is serving.** The code that runs is the
 * same either way; the service opens workers at start, and anything that never
 * does — a test, a one-off tool — carries its requests itself. So does a
 * process whose worker file is not built, and one whose every worker is gone
 * or waiting to be replaced — see `open`.
 */
export const carry = (url: string, read: PageRead | null): Promise<Carried> => {
  if (slots.length === 0) return deliver(url, read);

  const id   = ++lastId;
  const lane = serving(id);

  if (! lane) return deliver(url, read);

  return new Promise((resolve, reject) => {
    lane.waiting.set(id, { resolve, reject });
    lane.outbox.push({ id, url, read });

    schedule(lane);
  });
};

/**
 * Start carrying requests, on as many workers as `concurrency` — the
 * machine-wide ceiling on requests in flight — calls for.
 *
 * **The worker is the compiled `transport.worker.js` beside this file**, or
 * the file `worker` names. When that file does not exist — this module run
 * from its TypeScript source, as `ts-node` does — no worker is started, and
 * every request is carried in-process.
 */
export const openTransport = (concurrency: number, worker = join(__dirname, 'transport.worker.js')): void => {
  if (! existsSync(worker)) {
    logger.warn({ worker }, 'Transport worker not built; carrying requests in-process');

    return;
  }

  const workers = workersFor(concurrency);

  for (let i = 0; i < workers; i++) {
    const slot: Slot = { lane: null, exits: 0, worker };

    slots.push(slot);
    open(slot);
  }

  logger.info({ workers, concurrency }, 'Transport open');
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

const slots: Slot[] = [];

let lastId = 0;

/**
 * The worker to carry request `id`: its own slot's, or the next slot's that has
 * one. `null` when no slot has a worker.
 */
const serving = (id: number): Lane | null => {
  for (let step = 0; step < slots.length; step++) {
    const lane = slots[(id + step) % slots.length]!.lane;

    if (lane) return lane;
  }

  return null;
};

/** Start a worker in `slot`. */
const open = (slot: Slot): void => {
  const it: Lane = {
    worker:    new Worker(slot.worker),
    waiting:   new Map(),
    outbox:    [],
    scheduled: false,
  };

  const born = Date.now();

  let answered = false;

  slot.lane = it;

  it.worker.unref();

  it.worker.on('message', (receipts: Receipt[]) => {
    answered = true;

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
   * **A worker that dies is replaced after a wait, and what it held is failed.**
   * Every request in it fails as a transport error does, which is the case
   * `http.ts` already retries; nothing waits on an answer that will never come.
   *
   * **The wait doubles while workers keep dying young**: `RESPAWN_FROM_MS`,
   * then twice that, up to `RESPAWN_UP_TO_MS`. A worker that answered anything,
   * or lived `SETTLED_MS`, was working, and its exit starts the count again.
   * After `QUICK_EXITS` in a row the slot is left empty, and says so once: a
   * worker that keeps failing to start is not retried for ever. While a slot
   * is empty its requests go to the workers of other slots, or are carried
   * in-process when there are none.
   */
  it.worker.on('exit', code => {
    const lost = it.waiting.size;

    for (const waiting of it.waiting.values()) waiting.reject(new Error('Transport worker exited'));

    it.waiting.clear();

    if (slot.lane !== it) return;

    slot.lane = null;

    if (! slots.includes(slot)) return;

    if (answered || Date.now() - born >= SETTLED_MS) slot.exits = 0;

    slot.exits++;

    if (slot.exits >= QUICK_EXITS) {
      logger.error({ code, lost, exits: slot.exits }, 'Transport worker keeps exiting; no longer replacing it');

      return;
    }

    const inMs = Math.min(RESPAWN_UP_TO_MS, RESPAWN_FROM_MS * 2 ** (slot.exits - 1));

    logger.error({ code, lost, inMs }, 'Transport worker exited; starting another');

    setTimeout(() => {
      if (slots.includes(slot) && ! slot.lane) open(slot);
    }, inMs).unref();
  });
};

/** The first wait before a worker that exited is replaced. */
const RESPAWN_FROM_MS = 1_000;

/** The longest wait before a worker that exited is replaced. */
const RESPAWN_UP_TO_MS = 60_000;

/** How long a worker that has answered nothing must live to count as settled. */
const SETTLED_MS = 60_000;

/** Exits in a row, of workers that never settled, after which a slot is left empty. */
const QUICK_EXITS = 5;

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

/** The workers serving now, slot by slot. */
export const _test_lanes = (): (Lane | null)[] => slots.map(slot => slot.lane);

/** Back to carrying in-process: every slot dropped and its worker stopped. */
export const _test_closeTransport = async (): Promise<void> => {
  const closing = slots.splice(0).flatMap(slot => (slot.lane ? [slot.lane.worker.terminate()] : []));

  await Promise.all(closing);
};
