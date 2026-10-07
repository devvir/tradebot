import { parentPort } from 'node:worker_threads';
import { extractInto } from './extract';
import type { ExtractAsked, ExtractAnswered } from './types';

/**
 * A thread that extracts archives and does nothing else.
 *
 * It is handed archives and a directory, extracts one into the other, and says
 * what came of it. Everything about which archives, where, and when is decided
 * on the main thread — see `pool.ts`.
 */
parentPort!.on('message', (asked: ExtractAsked) => {
  extractInto(asked.inputs, asked.dir, asked.shapes).then(
    done => parentPort!.postMessage({ id: asked.id, ...done } satisfies ExtractAnswered),
    err  => parentPort!.postMessage({ id: asked.id, error: (err as Error).message } satisfies ExtractAnswered),
  );
});
