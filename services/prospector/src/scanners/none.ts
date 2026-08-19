import type { Scanner } from '../types';

/**
 * A venue that is **known but not yet reachable** — the null scanner, in the
 * sense a null logger is null.
 *
 * **It exists so that adding a venue is not all-or-nothing.** Registering one
 * means an id, a `venue` row, its exclusions, its documentation and its entry in
 * configuration, and none of that has to wait for a scanner that can read it: a
 * venue wired here is a complete, working registration that simply surveys to
 * nothing. Bitget spent its first months exactly like this, and the next venue
 * will too.
 *
 * **It surveys to nothing, which is the honest answer.** There is no keyspace
 * to read, so a walk finds no files, and a consumer looking for this venue in
 * the catalog correctly finds none. The run it completes marks the venue
 * established, which reads as *last surveyed* rather than as a claim that the
 * venue publishes nothing — the same marker every venue carries, moving forward
 * each time a walk finds more.
 *
 * `page` is unreachable while `scopes` is empty, and answers with an empty page
 * rather than throwing: a scanner is a description of how to read a venue, and
 * this one describes a venue with nothing to read.
 */
export const none: Scanner<unknown> = {
  name: 'none',

  scopes: async () => [],
  page:   async () => ({ listed: [], cursor: null }),

  /**
   * Nothing can be confirmed about a venue nothing can read. Null is the honest
   * answer and the safe one: a caller checking a claim treats it as unconfirmed
   * rather than as agreement.
   */
  confirm: async () => null,
};
