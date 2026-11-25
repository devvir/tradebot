/** A number of things, in words: `1 tar`, `2,048 files`. */
export const count = (n: number, what: string): string => `${n.toLocaleString('en-US')} ${what}${n === 1 ? '' : 's'}`;
