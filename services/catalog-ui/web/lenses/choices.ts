import type { Choice } from '../types';

/**
 * The words a rule is written in: variants in reading order, and a grain or a
 * bundle choice as a select offers and holds it.
 */

/**
 * Variants in the order a person reads them.
 *
 * **A bar length is not a word.** Sorted as text, a kline's variants come out
 * `10s, 12h, 15m, 1d, 1h, 1m, 1mo…`, which is nobody's idea of ascending. So
 * anything shaped like a period is ordered by how long it is, and anything else
 * falls back to the alphabet — a book depth has no duration and `400` beside
 * `full` sorts the only way it can.
 *
 * **Recognised by shape rather than by a list of datasets**, because the shape is
 * the fact: any variant written as a count and a unit is a period, whichever
 * dataset it belongs to.
 */
export const byPeriod = (a: string, b: string): number => {
  const one = seconds(a), two = seconds(b);

  if (one !== null && two !== null) return one - two;
  if (one !== null) return -1;
  if (two !== null) return 1;

  return a.localeCompare(b);
};

/** A variant as a duration in seconds, or null where it is not one. */
export const seconds = (variant: string): number | null => {
  const had = /^(\d+)(s|m|h|d|w|mo|y)$/.exec(variant);

  if (! had) return null;

  return Number(had[1]) * SPANS[had[2] as keyof typeof SPANS];
};

/** Each unit a period is written in, in seconds; a month is thirty days and a year 365. */
export const SPANS = {
  s: 1, m: 60, h: 3_600, d: 86_400, w: 604_800, mo: 2_592_000, y: 31_536_000,
} as const;

/** Leaving a grain or a bundle out of a rule takes any, which a select needs a value for. */
const ANY = 'any';

/** The bundles a rule can choose between. */
export const BUNDLES = [
  { value: 'instrument', label: 'per Instrument' },
  { value: 'market',     label: 'Market Bundles' },
];

/**
 * What a grain or a bundle select offers: any form, only one of them, or any
 * with one of them preferred — the last only where the rule can prefer.
 */
export const choices = (forms: { value: string; label: string }[], preferring: boolean): { value: string; label: string }[] => [
  { value: ANY, label: 'Any' },
  ...forms.map(one => ({ value: `only:${one.value}`, label: `Only ${one.label}` })),
  ...(preferring ? forms.map(one => ({ value: `prefer:${one.value}`, label: `Prefer ${one.label}` })) : []),
];

/** A rule's choice as the select's value, and back. */
export const chosenOf = (choice: Choice<string> | undefined): string =>
  (! choice || typeof choice !== 'object' ? ANY : 'only' in choice ? `only:${choice.only}` : `prefer:${choice.prefer}`);

export const choiceOf = (picked: string | null): Choice<string> | undefined => {
  if (! picked || picked === ANY) return undefined;

  const [how, form] = picked.split(':') as ['only' | 'prefer', string];

  return how === 'only' ? { only: form } : { prefer: form };
};

/** A choice kept where it takes one form alone, and dropped where it only prefers one. */
export const onlyOf = <T extends string>(choice: Choice<T> | undefined): Choice<T> | undefined =>
  (choice && typeof choice === 'object' && 'only' in choice ? choice : undefined);

/** A word with its first letter in upper case. */
export const capital = (word: string): string => word.charAt(0).toUpperCase() + word.slice(1);
