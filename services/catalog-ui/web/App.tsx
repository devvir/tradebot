import { useEffect, useState } from 'react';
import { Anchor, AppShell, Breadcrumbs, Container, Group, Tabs, Text, Title } from '@mantine/core';
import { Venues } from './views/Venues';
import { VenueView } from './views/Venue';
import { MarketView } from './views/Market';
import { Surveys } from './views/Surveys';
import { useAsk } from './api';
import type { Where } from './types';

/**
 * The whole page: a route read out of the hash, and the view that answers it.
 *
 * **The hash rather than a router.** Every view is a link somebody can send, and
 * that is all the routing this needs — a router would be a dependency to
 * reimplement `location.hash`.
 */

/**
 * Two sections, and where you are inside one of them.
 *
 * `contents` is what the catalog holds; `surveys` is what is being done about
 * it. They are separate because they answer different questions and change on
 * different clocks — one is a fact to read, the other a thing to act on.
 *
 * **`surveys` is the default**, because it is the one that changes: what the
 * catalog holds is still there tomorrow, while whether anything is collecting it
 * is the question somebody opens this page to answer.
 */
export type Section = 'contents' | 'surveys';

export interface Route {
  section:  Section;
  venue?:   string;
  market?:  string;
}

export const App = () => {
  const route = useRoute();
  const where = useAsk<Where>('/where',
    () => fetch('/api/where').then(res => res.json() as Promise<Where>));

  return (
    <AppShell header={{ height: 92 }} padding="md">
      <AppShell.Header>
        <Group px="md" py="xs" gap="md" align="baseline">
          <Title order={1} size="h5" style={{ letterSpacing: '.04em' }}>
            Catalog
          </Title>
          <Text size="xs" c="dimmed">
            {where.data?.catalog}
            {where.data?.hauler ? ` · hauler ${where.data.hauler}` : ''}
          </Text>
        </Group>

        <Tabs
          value={route.section}
          onChange={value => { location.hash = linkTo({ section: value as Section }).slice(1); }}
          px="md"
        >
          <Tabs.List>
            <Tabs.Tab value="surveys">Surveys</Tabs.Tab>
            <Tabs.Tab value="contents">Contents</Tabs.Tab>
          </Tabs.List>
        </Tabs>
      </AppShell.Header>

      <AppShell.Main>
        <Container size="xl" px={0}>
          {route.section === 'contents' && <Crumbs route={route} />}

          {route.section === 'surveys' ? <Surveys />
            : route.venue === undefined ? <Venues />
              : route.market !== undefined
                ? <MarketView venue={route.venue} market={route.market} />
                : <VenueView venue={route.venue} />}
        </Container>
      </AppShell.Main>
    </AppShell>
  );
};

/** A view's address, so no caller assembles a hash by hand. */
export const linkTo = (route: Partial<Route>): string => {
  const parts = new URLSearchParams();

  /**
   * **A link with no section named means contents**, because every one of them
   * is a venue or a market — the surveys view has no depth to link into. So the
   * section is spelled out for contents and left off for the default, which
   * keeps the bare `#` meaning what the tabs mean by it.
   */
  const section = route.section ?? 'contents';

  if (section !== 'surveys') parts.set('section', section);
  if (route.venue) parts.set('venue', route.venue);
  if (route.market) parts.set('market', route.market);

  return `#${parts.toString()}`;
};

// ── Internals ─────────────────────────────────────────────────────────────────

const useRoute = (): Route => {
  const [route, setRoute] = useState<Route>(readRoute);

  useEffect(() => {
    const onHash = () => setRoute(readRoute());

    addEventListener('hashchange', onHash);

    return () => removeEventListener('hashchange', onHash);
  }, []);

  return route;
};

const readRoute = (): Route => {
  const parts = new URLSearchParams(location.hash.slice(1));

  return {
    section: parts.get('section') === 'contents' ? 'contents' : 'surveys',
    ...(parts.get('venue') ? { venue: parts.get('venue')! } : {}),
    ...(parts.get('market') ? { market: parts.get('market')! } : {}),
  };
};

/**
 * Where you are, as links back.
 *
 * **Only the last one is plain text**, because a crumb you are already on is not
 * somewhere to go — and the previous version rendered these beside the tabs,
 * where "venues" read as a third tab.
 */
const Crumbs = ({ route }: { route: Route }) => {
  const here: React.ReactNode[] = [
    route.venue === undefined
      ? <Text key="v" size="sm">Venues</Text>
      : <Anchor key="v" size="sm" href={linkTo({})}>Venues</Anchor>,
  ];

  if (route.venue !== undefined)
    here.push(route.market === undefined
      ? <Text key="n" size="sm">{route.venue}</Text>
      : <Anchor key="n" size="sm" href={linkTo({ venue: route.venue })}>{route.venue}</Anchor>);

  if (route.market !== undefined) here.push(<Text key="m" size="sm">{route.market}</Text>);

  return <Breadcrumbs separator="/" mb="lg">{here}</Breadcrumbs>;
};
