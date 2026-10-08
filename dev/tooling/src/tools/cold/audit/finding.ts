import type { Finding } from './types';

/** A finding, where there is anything to find. */
export const found = (problem: string, examples: string[], solutions: Finding['solutions'], note?: string): Finding[] =>
  examples.length === 0 ? [] : [{ problem, examples, solutions, ...(note ? { note } : {}) }];

export const count = (n: number, what: string): string => `${n.toLocaleString('en-US')} ${what}${n === 1 ? '' : 's'}`;

export const are = (list: readonly unknown[]): string => (list.length === 1 ? 'is' : 'are');
