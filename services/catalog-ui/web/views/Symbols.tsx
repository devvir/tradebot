import { useMemo, useState } from 'react';
import { Badge, Button, Collapse, Group, Stack, Text, TextInput } from '@mantine/core';
import { catalog, useAsk } from '../api';
import { Waiting, count } from './Table';

/**
 * Every instrument in a venue, or in one of its markets.
 *
 * **Filtered rather than paged.** A few thousand strings is one response and one
 * render; paging would add a cursor to carry and a page to be on, to save
 * nothing anybody would notice.
 */
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
export const SymbolsPanel = ({ venue, market }: { venue: string; market?: string }) => {
  const [showing, setShowing] = useState(false);

  const what = market === undefined ? 'at this venue' : `in ${market}`;

  return (
    <Stack gap="md">
      <Group>
        <Button size="xs" variant="default" onClick={() => setShowing(! showing)}>
          {showing ? 'Hide symbols' : `Every symbol ${what}`}
        </Button>
      </Group>

      <Collapse in={showing}>
        {showing && <SymbolList venue={venue} market={market} />}
      </Collapse>
    </Stack>
  );
};

const SymbolList = ({ venue, market }: { venue: string; market?: string }) => {
  const at = market === undefined
    ? `/contents/venues/${encodeURIComponent(venue)}/symbols`
    : `/contents/venues/${encodeURIComponent(venue)}/markets/${encodeURIComponent(market)}/symbols`;

  const asked = useAsk<{ items: string[] }>(at, catalog);

  return (
    <Waiting asked={asked}>
      {({ items }) => <Filtered venue={venue} market={market} items={items} />}
    </Waiting>
  );
};

// ── Internals ─────────────────────────────────────────────────────────────────

const Filtered = ({ venue, market, items }: {
  venue: string; market?: string; items: string[];
}) => {
  const [query, setQuery] = useState('');

  const kept = useMemo(() => {
    const wanted = query.trim().toUpperCase();

    return wanted ? items.filter(one => one.toUpperCase().includes(wanted)) : items;
  }, [items, query]);

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

      <Group gap={6}>
        {kept.map(one => <Badge key={one} variant="default" size="sm">{one}</Badge>)}
      </Group>
    </Stack>
  );
};
