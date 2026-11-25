import type { LensDefinition, LensProblem, LensRule, RuleEntry } from '../types';

/**
 * A lens's rules as an editor holds them, and the definitions sent from them.
 *
 * Each rule is an entry: what is stored (`saved`, absent for a draft never
 * confirmed) beside what is written now (`now`), under a key of its own that
 * stays with it while rules around it come and go.
 */

/** Where a rule stands: never confirmed, confirmed and edited since, or as stored. */
export const stateOf = (entry: RuleEntry): 'new' | 'changed' | 'saved' =>
  (! entry.saved ? 'new' : JSON.stringify(entry.saved) === JSON.stringify(entry.now) ? 'saved' : 'changed');

/** A stored definition as the editor holds it: every rule saved, none drafted. */
export const entriesOf = (definition: LensDefinition): Record<string, RuleEntry[]> =>
  Object.fromEntries(Object.entries(definition.venues ?? {})
    .map(([venue, list]) => [venue, list.map(rule => ({ key: freshKey(), saved: rule, now: rule }))]));

let keys = 0;

/** A key no other entry has. */
export const freshKey = (): string => `r${Date.now().toString(36)}${(keys++).toString(36)}`;

/**
 * A definition to store, and which entry each rule in it is: for each venue,
 * the keys of the entries sent, in the order their rules are — so a problem the
 * catalog places at a venue and a position is placed on the entry it is about.
 */
export interface Sending {
  definition: LensDefinition;
  sent:       Record<string, string[]>;
}

/**
 * The lens as stored, with one entry's draft in place of — or beside — what it
 * was, or, with `drop`, without it. Drafts of other entries are not sent.
 */
export const withOne = (
  rules: Record<string, RuleEntry[]>, venue: string, entry: RuleEntry, drop = false,
): Sending => {
  const venues: LensDefinition['venues'] = {};
  const sent:   Sending['sent'] = {};

  for (const [each, list] of Object.entries({ ...rules, [venue]: rules[venue] ?? [] })) {
    const kept: LensRule[] = [];
    const keys: string[]   = [];

    for (const one of list) {
      const rule = one.key === entry.key ? (drop ? undefined : one.now) : one.saved;

      if (rule === undefined) continue;

      kept.push(rule);
      keys.push(one.key);
    }

    if (kept.length > 0) { venues[each] = kept; sent[each] = keys; }
  }

  return { definition: { format: 1, venues }, sent };
};

/** The lens as stored, less every rule of one venue. */
export const withoutVenue = (rules: Record<string, RuleEntry[]>, venue: string): Sending => {
  const { definition, sent } = withOne(rules, venue, { key: '', now: { effect: 'include' } }, true);

  delete definition.venues[venue];
  delete sent[venue];

  return { definition, sent };
};

/**
 * What the catalog found wrong, filed by the entry each problem is about. A
 * problem about no rule, or about one that was not sent, is the lens's own.
 */
export const filed = (found: LensProblem[], sent: Sending['sent']):
  { byKey: Record<string, LensProblem[]>; general: LensProblem[] } => {
  const byKey: Record<string, LensProblem[]> = {};
  const general: LensProblem[] = [];

  for (const one of found) {
    const key = one.rule >= 0 ? sent[one.venue]?.[one.rule] : undefined;

    if (key === undefined) general.push(one);
    else (byKey[key] ??= []).push(one);
  }

  return { byKey, general };
};

/** A record less the given keys; the record itself is left as it was. */
export const without = <T>(had: Record<string, T>, keys: string[]): Record<string, T> => {
  const next = { ...had };

  for (const one of keys) delete next[one];

  return next;
};
