import { memo, useDeferredValue, useMemo, useState } from 'react';
import { Box, Button, Collapse, Group, Stack, Text, TextInput } from '@mantine/core';
import { catalogLensed, lensed, useAsk } from '../api';
import { Waiting, count } from './Table';

/**
 * The symbols, behind a button, fetched only once somebody asks.
 *
 * **Not loaded with the view.** A venue's instruments are thousands of strings
 * and the question they answer is a second one — read the shapes, then ask which
 * instruments carry them. Fetching them alongside would spend the request on
 * every visit to pay for the visits that wanted it.
 *
 * `SymbolList` mounts only while open, so the request happens on the first
 * opening and not before.
 */
export const SymbolsPanel = ({ venue, market, lens }: { venue: string; market?: string; lens?: string }) => {
  const [showing, setShowing] = useState(false);

  const what = market === undefined ? 'at this venue' : `in ${market}`;

  return (
    <Stack gap="md">
      <Group>
        <Button size="xs" variant="default" onClick={() => setShowing(! showing)}>
          {showing ? 'Hide symbols' : `Every symbol ${what}`}
        </Button>
      </Group>

      <Collapse expanded={showing}>
        {showing && <SymbolList venue={venue} market={market} lens={lens} />}
      </Collapse>
    </Stack>
  );
};

/**
 * Every instrument in a venue, or in one of its markets.
 *
 * **Filtered rather than paged.** A few thousand strings is one response and one
 * render; paging would add a cursor to carry and a page to be on, to save
 * nothing anybody would notice.
 */
const SymbolList = ({ venue, market, lens }: { venue: string; market?: string; lens?: string }) => {
  const at = market === undefined
    ? `/venues/${encodeURIComponent(venue)}/symbols`
    : `/venues/${encodeURIComponent(venue)}/markets/${encodeURIComponent(market)}/symbols`;

  const asked = useAsk<{ items: string[] }>(lensed(at, lens), catalogLensed);

  return (
    <Waiting asked={asked}>
      {({ items }) => <Filtered venue={venue} market={market} items={items} />}
    </Waiting>
  );
};

// ── Internals ─────────────────────────────────────────────────────────────────

/** The symbols that contain `query`, ignoring case; every one of them where it is blank. */
export const matching = (items: readonly string[], query: string): readonly string[] => {
  const wanted = query.trim().toUpperCase();

  return wanted ? items.filter(one => one.toUpperCase().includes(wanted)) : items;
};

/**
 * The list, and the box that narrows it.
 *
 * **The box answers every keystroke; the list catches up.** The list is
 * filtered from a deferred copy of the query, so React renders a few thousand
 * names at low priority and abandons that render when another key arrives —
 * typing never waits on it. `Names` is memoised so the urgent render, which
 * still holds the old query, skips the list entirely. Until the new one lands,
 * the list is dimmed: what is on screen is the answer to an earlier query.
 *
 * **Plain spans, not badges.** A name here is text to read and scan, and a
 * component per name costs a few thousand of them on every render.
 */
const Filtered = ({ venue, market, items }: {
  venue: string; market?: string; items: string[];
}) => {
  const [query, setQuery] = useState('');
  const shown = useDeferredValue(query);

  const kept = useMemo(() => matching(items, shown), [items, shown]);

  return (
    <Stack gap="sm">
      <Text tt="uppercase" fz="xs" c="dimmed">
        {[venue, market].filter(Boolean).join(' ')} — {count(items.length)} symbols
        {kept.length !== items.length && ` · ${count(kept.length)} shown`}
      </Text>

      <TextInput
        value={query}
        placeholder="Filter symbols…"
        size="xs"
        w={280}
        onChange={event => setQuery(event.currentTarget.value)}
      />

      <Box className="symbols" data-stale={shown !== query || undefined}>
        <Names names={kept} />
      </Box>
    </Stack>
  );
};

const Names = memo(({ names }: { names: readonly string[] }) =>
  names.map(one => <span key={one} className="symbol">{one}</span>));
