import { BUNDLE, locate, variantsOf } from './layout';
import type { Selection } from '../../types';

/**
 * Which of the vault a selection means.
 *
 * **Read off the partition's own name.** A vault partition is named by where it
 * sits — `venue=…/market=…/dataset=…[/interval=…][/kind=…]/<month>` — so what a
 * selection narrows by is what the path already says, and nothing is looked up.
 */

/** Whether a partition is one the selection means, whatever its files. */
export const meansPartition = (selection: Selection, partition: string): boolean => {
  const { month, levels } = locate(partition);

  return (selection.venues.length === 0 || selection.venues.includes(levels['venue'] ?? ''))
    && same(selection.market, levels['market'])
    && same(selection.dataset, levels['dataset'])
    && (! selection.variant || variantsOf(levels).some(one => same(selection.variant, one)))
    && (! selection.from || month >= selection.from)
    && (! selection.to || month <= selection.to);
};

/**
 * Whether a file is one the selection means **to take away**.
 *
 * Where instruments are named, only their own files: the file of a partition
 * stored whole holds every instrument, and taking it away for the sake of one
 * would take the rest with it.
 */
export const meansToEvict = (selection: Selection, partition: string, instrument: string): boolean =>
  meansPartition(selection, partition)
  && (selection.instruments.length === 0 || (instrument !== BUNDLE && named(selection, instrument)));

/**
 * Whether a file is one the selection means **to bring back**.
 *
 * Where instruments are named, their own files — and the file of a partition
 * stored whole, since that is where an instrument's rows are when its month was
 * small enough to be one file.
 */
export const meansToPull = (selection: Selection, partition: string, instrument: string): boolean =>
  meansPartition(selection, partition)
  && (selection.instruments.length === 0 || instrument === BUNDLE || named(selection, instrument));

// ── Internals ─────────────────────────────────────────────────────────────────

const same = (asked: string | undefined, held: string | undefined): boolean =>
  ! asked || asked.toLowerCase() === (held ?? '').toLowerCase();

const named = (selection: Selection, instrument: string): boolean =>
  selection.instruments.some(one => one.toLowerCase() === instrument.toLowerCase());
