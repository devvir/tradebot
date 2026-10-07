import { statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { Packer } from './pack';
import { containerFor } from './registry';
import type { Extracted, Pack, Wrapped } from './types';

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
 *
 * **Small members of an archive given a shape are gathered**, one file a
 * shape, and not written out one by one — see `Packer`. What cannot be
 * gathered is extracted as it always was, or left where it lies for the engine
 * where the engine reads it as it is.
 */
export const extractInto = async (
  inputs: readonly Wrapped[],
  dir:    string,
  shapes: readonly Pack[] = [],
): Promise<Extracted> => {
  const paths: string[][] = inputs.map(() => []);
  const packers = shapes.map((shape, at) => new Packer(join(dir, `@pack-${at}.csv`), shape));

  let next    = 0;
  let bytes   = 0;
  let yielded = Date.now();

  const worker = async (): Promise<void> => {
    while (next < inputs.length) {
      const at      = next++;
      const input   = inputs[at]!;
      const handler = containerFor(input.container);
      const packer  = input.shape === undefined ? undefined : packers[input.shape];
      const members = packer ? handler.members?.(input.absolute) ?? null : null;

      if (members && packer) {
        for (const member of members) {
          if (packer.add(at, member.data)) continue;

          // Not gathered: read where it lies, where the engine can, and written out where it cannot.
          if (handler.native) {
            paths[at] = [input.absolute];

            continue;
          }

          const out = join(dir, `${at}-${basename(member.name)}`);

          writeFileSync(out, member.data);

          paths[at]!.push(out);
          bytes += member.data.length;
        }
      }
      else if (handler.native) {
        paths[at] = [input.absolute];

        continue;
      }
      else {
        paths[at] = await handler.unpack(input.absolute, dir, `${at}-`);

        for (const path of paths[at]!) bytes += statSync(path).size;
      }

      if (Date.now() - yielded >= BREATH_MS) {
        await new Promise(resolve => setImmediate(resolve));

        yielded = Date.now();
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(WIDTH, inputs.length) }, worker));

  const packs = packers.map(packer => packer.close());

  return { paths, packs, bytes: bytes + packers.reduce((total, packer) => total + packer.bytes, 0) };
};

/** Whether any of these has to be extracted, or looked at to be gathered, before the engine reads it. */
export const needsExtracting = (inputs: readonly Wrapped[]): boolean =>
  inputs.some(input => input.shape !== undefined || ! containerFor(input.container).native);

/** Archives extracted at once on one thread. What it buys is on the large ones, which are streamed. */
const WIDTH = 4;

/** How long extraction may hold a thread before handing it back. */
const BREATH_MS = 20;
