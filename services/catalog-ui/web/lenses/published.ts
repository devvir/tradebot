import { catalog } from '../api';
import type { LensOption } from '../types';

/** How long one reading of what the venues publish is used before it is asked for again. */
const PUBLISHED_FOR_MS = 60_000;

let asked: { at: number; options: Promise<LensOption[]> } | null = null;

/**
 * What the venues publish, as the catalog's `/lenses/options` lists it: one
 * request shared by every caller for `PUBLISHED_FOR_MS`. A failed one is
 * forgotten at once, so the next caller asks again rather than being handed the
 * same failure.
 */
export const publishedOptions = (): Promise<LensOption[]> => {
  if (asked === null || Date.now() - asked.at > PUBLISHED_FOR_MS) {
    const held = { at: Date.now(), options: catalog<{ items: LensOption[] }>('/lenses/options').then(({ items }) => items) };

    held.options.catch(() => { if (asked === held) asked = null; });

    asked = held;
  }

  return asked.options;
};
