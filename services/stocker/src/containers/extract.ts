import { statSync } from 'node:fs';
import { containerFor } from './registry';
import type { Extracted, Wrapped } from './types';

/**
 * Extract these archives into `dir`, each under a tag of its own, and say what
 * each became and what it all weighs.
 *
 * **It knows nothing of the service** — no configuration, no logger, no
 * database — because it runs on the main thread and in a worker alike, and a
 * worker is handed a list and a directory and nothing else.
 *
 * **A few at a time, and the thread is handed back as they go.** A small zip is
 * extracted without waiting on anything — see `zip` — so thousands in a row
 * would otherwise hold the thread for as long as they take. In a worker that
 * costs nobody anything; on the main thread it is everything else the service
 * does.
 */
export const extractInto = async (inputs: readonly Wrapped[], dir: string): Promise<Extracted> => {
  const paths: string[][] = inputs.map(() => []);

  let next    = 0;
  let bytes   = 0;
  let yielded = Date.now();

  const worker = async (): Promise<void> => {
    while (next < inputs.length) {
      const at      = next++;
      const input   = inputs[at]!;
      const handler = containerFor(input.container);

      if (handler.native) {
        paths[at] = [input.absolute];

        continue;
      }

      paths[at] = await handler.unpack(input.absolute, dir, `${at}-`);

      for (const path of paths[at]!) bytes += statSync(path).size;

      if (Date.now() - yielded >= BREATH_MS) {
        await new Promise(resolve => setImmediate(resolve));

        yielded = Date.now();
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(WIDTH, inputs.length) }, worker));

  return { paths, bytes };
};

/** Whether any of these has to be extracted before the engine can read it. */
export const needsExtracting = (inputs: readonly Wrapped[]): boolean =>
  inputs.some(input => ! containerFor(input.container).native);

/** Archives extracted at once on one thread. What it buys is on the large ones, which are streamed. */
const WIDTH = 4;

/** How long extraction may hold a thread before handing it back. */
const BREATH_MS = 20;
