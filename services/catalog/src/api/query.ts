/**
 * A request's query parameters, read one at a time at the API's edge.
 *
 * **Each parameter is given once.** A parameter given twice arrives as a list,
 * which is neither of its values: each reader says so with `INVALID` (or
 * `'invalid'`), and its route refuses the request.
 */

import { BUNDLES, GRAINS } from '@tradebot/lenses';
import type { Bundle, Grain } from '../types';

/** A parameter given more than once, or as anything but text. */
export const INVALID: unique symbol = Symbol('invalid');

/** A parameter's text: `undefined` where it is absent or empty, `INVALID` where it is not one value. */
export const queryText = (raw: unknown): string | undefined | typeof INVALID => {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string') return INVALID;

  return raw === '' ? undefined : raw;
};

/**
 * A yes-or-no parameter: `true`, `1` or no value at all (`?settled`) for yes,
 * `false` or `0` for no, `undefined` where it is absent, and `'invalid'` for
 * anything else.
 */
export const flag = (raw: unknown): boolean | undefined | 'invalid' => {
  if (raw === undefined) return undefined;
  if (raw === '' || raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;

  return 'invalid';
};

/** A grain, from a parameter's text: `undefined` where none was given, `'invalid'` where it is not one of `GRAINS`. */
export const grainOf = (text: string | undefined): Grain | undefined | 'invalid' =>
  (text === undefined ? undefined : (GRAINS as readonly string[]).includes(text) ? text as Grain : 'invalid');

/** A bundle, from a parameter's text: `undefined` where none was given, `'invalid'` where it is not one of `BUNDLES`. */
export const bundleOf = (text: string | undefined): Bundle | undefined | 'invalid' =>
  (text === undefined ? undefined : (BUNDLES as readonly string[]).includes(text) ? text as Bundle : 'invalid');

/**
 * Whether XML 1.0 can carry a text: no control character but tab, newline and
 * carriage return, no unpaired surrogate, no U+FFFE or U+FFFF. A text that
 * cannot is refused, never stripped — stripped, it would ask for something else.
 */
export const xmlCarries = (text: string): boolean => ! NOT_XML.test(text);

// ── Internals ─────────────────────────────────────────────────────────────────

const NOT_XML = /[^\t\n\r -퟿-�\u{10000}-\u{10FFFF}]/u;
