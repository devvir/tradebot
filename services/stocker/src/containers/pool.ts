import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { extractInto } from './extract';
import type { ExtractAnswered, Extracted, Pack, PoolWorker, Wrapped } from './types';

/**
 * Threads that extract archives, so that extraction runs beside the builds and
 * not in between them.
 *
 * **Extraction is most of what a month of small files costs**, and none of it
 * needs the engine: it is reading tens of thousands of tiny archives and
 * writing what is in them. On the main thread that work takes turns with every
 * build's own waiting. On threads of its own it runs while the engine works,
 * and as many extractions run at once as there are threads.
 *
 * **One extraction a thread at a time, handed out in the order asked.** Which
 * extractions are worth starting, and how many, is decided by whoever asks —
 * see `prepare.ts`. With no threads configured the work is done where it is
 * asked for, on the main thread, and nothing else changes.
 */
export class Pool {
  constructor(private readonly width: number) {}

  private readonly idle:    PoolWorker[] = [];
  private readonly queued:  { inputs: readonly Wrapped[]; dir: string; shapes: readonly Pack[]; settle: PoolWorker['settle'] & {} }[] = [];
  private started = 0;
  private sequence = 0;

  /** How many extractions can run at once. */
  get size(): number {
    return Math.max(1, this.width);
  }

  extract(inputs: readonly Wrapped[], dir: string, shapes: readonly Pack[] = []): Promise<Extracted> {
    if (this.width <= 0 || ! existsSync(WORKER)) return extractInto(inputs, dir, shapes);

    return new Promise<Extracted>((resolve, reject) => {
      this.queued.push({ inputs, dir, shapes, settle: { resolve, reject } });
      this.pump();
    });
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  private pump(): void {
    while (this.queued.length > 0) {
      const worker = this.idle.pop() ?? (this.started < this.width ? this.start() : null);

      if (! worker) return;

      const { inputs, dir, shapes, settle } = this.queued.shift()!;

      worker.settle = settle;
      worker.thread.postMessage({ id: ++this.sequence, inputs, dir, shapes });
    }
  }

  private start(): PoolWorker {
    const worker: PoolWorker = { thread: new Worker(WORKER), settle: null };

    this.started++;

    // The pool waits on work, never the process on the pool.
    worker.thread.unref();

    worker.thread.on('message', (answered: ExtractAnswered) => {
      const settle = worker.settle;

      worker.settle = null;
      this.idle.push(worker);

      if ('error' in answered) settle?.reject(new Error(answered.error));
      else settle?.resolve({ paths: answered.paths, packs: answered.packs, bytes: answered.bytes });

      this.pump();
    });

    /** A thread that died takes its extraction with it, and is replaced by the next one asked for. */
    worker.thread.on('error', (err) => {
      worker.settle?.reject(err as Error);
      worker.settle = null;

      this.started--;
      this.pump();
    });

    return worker;
  }
}

/** The compiled worker beside this file. Absent where the service runs from source, as its tests do. */
const WORKER = join(__dirname, 'worker.js');
