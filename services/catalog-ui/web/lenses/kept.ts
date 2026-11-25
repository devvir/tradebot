import { forgetSize } from './size';
import type { Lens, LensDraft } from '../types';

/**
 * What this browser keeps of lenses between visits: the draft of a lens being
 * edited, and a new lens not saved yet.
 *
 * A draft is kept against the version of the lens it was written from, and is
 * only ever handed back for that version. Storage that refuses or holds
 * something unreadable is the same as nothing kept.
 */

const drafted = (slug: string) => `catalog-ui.lens-draft.${slug}`;

/** The draft kept for exactly this version of a lens, or none. */
export const keptFor = (lens: Lens): LensDraft | null => {
  try {
    const had = localStorage.getItem(drafted(lens.slug));

    if (had === null) return null;

    const draft = JSON.parse(had) as LensDraft;

    return draft.from === lens.updatedAt && draft.rules ? draft : null;
  } catch {
    return null;
  }
};

/** Keep a lens's draft, or with null, forget it. */
export const keep = (lens: Lens, draft: LensDraft | null): void => {
  try {
    if (draft === null) localStorage.removeItem(drafted(lens.slug));
    else localStorage.setItem(drafted(lens.slug), JSON.stringify(draft));
  } catch {
    // A browser refusing storage is not a reason to stop editing.
  }
};

/** Everything this browser keeps of a lens that is gone: its draft and its last known size. */
export const forget = (lens: Lens): void => {
  keep(lens, null);
  forgetSize(lens.slug);
};

/**
 * What a lens not saved yet has for `updatedAt`: when it was named. So it is
 * a version of its own, and a draft left at its address by an earlier lens is
 * never taken for its own.
 */
const UNSAVED_SINCE = 'unsaved:';

/** A new lens, as named: not saved, with no rules. */
export const namedLens = (slug: string, name: string, note: string): Lens => ({
  slug, name, note,
  createdAt: '', updatedAt: `${UNSAVED_SINCE}${Date.now()}`, definition: { format: 1, venues: {} },
});

/** Whether a lens is only this page's: never stored by the catalog. */
export const isUnsaved = (lens: Lens): boolean => lens.id === undefined || lens.updatedAt.startsWith(UNSAVED_SINCE);

const UNSAVED = 'catalog-ui.lens-unsaved';

/**
 * The new lens not saved yet, if any, as this browser kept it — or none, where
 * what is kept is not shaped like a lens.
 */
export const unsavedLens = (): Lens | null => {
  try {
    const kept = JSON.parse(localStorage.getItem(UNSAVED) ?? 'null') as
      { slug?: unknown; definition?: { venues?: unknown } } | null;

    const venues = kept?.definition?.venues;

    return typeof kept?.slug === 'string' && typeof venues === 'object' && venues !== null
      ? kept as Lens
      : null;
  } catch {
    return null;
  }
};

/** Keep the new lens not saved yet, or with null, forget it. */
export const keepUnsaved = (lens: Lens | null): void => {
  try {
    if (lens === null) localStorage.removeItem(UNSAVED);
    else localStorage.setItem(UNSAVED, JSON.stringify(lens));
  } catch { /* storage refused: the new lens lasts as long as the page */ }
};
