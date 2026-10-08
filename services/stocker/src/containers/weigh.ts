import { statSync } from 'node:fs';
import { containerFor } from './registry';
import type { Wrapped } from './types';

/**
 * What extracting each of these archives writes to scratch, in bytes.
 *
 * **Stated where the archive states it**, which a zip does, in its directory.
 * One that does not is counted at `EXPANSION` times what it weighs on disk: an
 * estimate, and said to be. One the engine reads as it lies writes nothing.
 */
export const weightsOf = async (inputs: readonly Wrapped[]): Promise<number[]> => {
  const weights: number[] = [];

  for (const input of inputs) {
    const handler = containerFor(input.container);

    if (handler.native && input.shape === undefined) weights.push(0);
    else weights.push(await handler.weight?.(input.absolute) ?? statSync(input.absolute).size * EXPANSION);
  }

  return weights;
};

/** What an extracted archive is taken to weigh against its compressed size, where nothing states it. */
export const EXPANSION = 8;

/**
 * The most an archive can inflate to, against its compressed size: what deflate
 * reaches on a file of one repeated byte. Nothing extracted outweighs it, so
 * what fits at this ratio fits without the archive being opened.
 */
export const MOST = 1032;
