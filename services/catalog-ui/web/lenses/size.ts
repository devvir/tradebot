import type { Lens, LensSize } from '../types';

/**
 * A lens's size as this browser last saw it, kept per lens and per version, so
 * an open lens shows a figure before the catalog answers.
 *
 * Storage that refuses or holds something unreadable is the same as nothing
 * kept.
 */

/** Where a lens's last known size is kept, one entry per lens. */
const sizeKey = (slug: string): string => `catalog-ui:lens-size:${slug}`;

/** The size last seen for exactly this saved lens, or undefined where it was never sized here. */
export const seenSize = (lens: Lens): LensSize | undefined => {
  try {
    const held = JSON.parse(localStorage.getItem(sizeKey(lens.slug)) ?? 'null') as
      { updatedAt: string; size: LensSize } | null;

    return held && held.updatedAt === lens.updatedAt ? held.size : undefined;
  } catch {
    return undefined;
  }
};

/** Keep a size as this version of the lens's. */
export const keepSize = (lens: Lens, size: LensSize): void => {
  try {
    localStorage.setItem(sizeKey(lens.slug), JSON.stringify({ updatedAt: lens.updatedAt, size }));
  } catch { /* storage refused: the next visit waits for the answer instead */ }
};

/** Forget whatever size is kept at an address, whichever version it was for. */
export const forgetSize = (slug: string): void => {
  try {
    localStorage.removeItem(sizeKey(slug));
  } catch { /* storage refused: what it holds is never read for a lens that is not there */ }
};

/** Whether a size says how much of it is downloaded: one with no files, or none counted, does not. */
export const known = (size: LensSize): boolean => size.files > 0 && typeof size.pendingBytes === 'number';
