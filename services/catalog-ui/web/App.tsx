import { useEffect, useState } from 'react';
import { Anchor, AppShell, Breadcrumbs, Container, Group, Select, Tabs, Text, Title } from '@mantine/core';
import { Venues } from './views/Venues';
import { VenueView } from './views/Venue';
import { MarketView } from './views/Market';
import { Surveys } from './views/Surveys';
import { Lenses } from './views/Lenses';
import { catalog, useAsk } from './api';
import type { Lens, Where } from './types';

/**
 * The whole page: a route read out of the hash, and the view that answers it.
 *
 * **The hash rather than a router.** Every view is a link somebody can send, and
 * that is all the routing this needs — a router would be a dependency to
 * reimplement `location.hash`. It reads as a path:
 *
 * ```
 * #surveys                                    (or nothing at all)
 * #contents[/:venue[/:market]][?lens=:slug]
 * #lenses[/:slug]
 * ```
 */

/**
 * Three sections, and where you are inside one of them.
 *
 * `contents` is what the catalog holds; `surveys` is what is being done about
 * it; `lenses` is how a consumer sees a slice of it. They are separate
 * because they answer different questions and change on different clocks — one
 * is a fact to read, one a thing to act on, and one a decision that stays until
 * it is changed.
 *
 * **`surveys` is the default**, because it is the one that changes: what the
 * catalog holds is still there tomorrow, while whether anything is collecting it
 * is the question somebody opens this page to answer.
 */
export type Section = 'contents' | 'surveys' | 'lenses';

export interface Route {
  section:  Section;
  venue?:   string;
  market?:  string;

  /**
   * The lens in question: in contents, the one they are seen through (absent for
   * the whole catalog); in lenses, the one being edited.
   */
  lens?:    string;
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
          </Text>
        </Group>

        <Tabs
          value={route.section}
          onChange={value => { location.hash = linkTo(tabTo(value as Section)).slice(1); }}
          px="md"
        >
          <Tabs.List>
            <Tabs.Tab value="surveys">Surveys</Tabs.Tab>
            <Tabs.Tab value="contents">Contents</Tabs.Tab>
            <Tabs.Tab value="lenses">Lenses</Tabs.Tab>
          </Tabs.List>
        </Tabs>
      </AppShell.Header>

      <AppShell.Main>
        <Container size="xl" px={0}>
          {route.section === 'contents' && <Crumbs route={route} />}

          {route.section === 'surveys' ? <Surveys />
            : route.section === 'lenses' ? <Lenses slug={route.lens} />
              : route.venue === undefined ? <Venues lens={route.lens} />
                : route.market !== undefined
                  ? <MarketView venue={route.venue} market={route.market} lens={route.lens} />
                  : <VenueView venue={route.venue} lens={route.lens} />}
        </Container>
      </AppShell.Main>
    </AppShell>
  );
};

/** A view's address, so no caller assembles a hash by hand. */
export const linkTo = (route: Partial<Route>): string => {
  /**
   * **A link with no section named means contents**, because every one of them
   * is a venue or a market — the surveys view has no depth to link into.
   */
  const section = route.section ?? 'contents';

  if (section === 'surveys') return '#surveys';

  if (section === 'lenses') return route.lens ? `#lenses/${encodeURIComponent(route.lens)}` : '#lenses';

  const path = ['contents', route.venue, route.venue ? route.market : undefined]
    .filter((one): one is string => Boolean(one))
    .map(encodeURIComponent)
    .join('/');

  /**
   * **A lens follows you through the contents** unless a link says otherwise, so
   * clicking from a venue into a market keeps looking through the same one.
   */
  const here = readRoute();
  const lens = 'lens' in route ? route.lens : here.section === 'contents' ? here.lens : undefined;

  return lens ? `#${path}?lens=${encodeURIComponent(lens)}` : `#${path}`;
};

/**
 * Remember the lens last opened in the lenses section, so leaving it and coming
 * back by its tab lands on the same one. Per browser, and never essential: where
 * storage is refused, the tab opens the first lens.
 */
export const rememberLens = (slug: string): void => {
  try { localStorage.setItem(LAST_LENS, slug); } catch { /* storage refused */ }
};

// ── Internals ─────────────────────────────────────────────────────────────────

const LAST_LENS = 'catalog-ui:last-lens';

/** Where a tab goes: the lenses tab goes back to the lens last opened there. */
const tabTo = (section: Section): Partial<Route> => {
  if (section !== 'lenses') return { section };

  let lens: string | null = null;

  try { lens = localStorage.getItem(LAST_LENS); } catch { /* storage refused */ }

  return lens ? { section, lens } : { section };
};

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
  const [path = '', query = ''] = location.hash.slice(1).split('?');
  const [head, ...rest] = path.split('/').filter(Boolean).map(decode);

  if (head === 'lenses') return { section: 'lenses', ...(rest[0] ? { lens: rest[0] } : {}) };

  if (head !== 'contents') return { section: 'surveys' };

  const lens = new URLSearchParams(query).get('lens');

  return {
    section: 'contents',
    ...(rest[0] ? { venue: rest[0] } : {}),
    ...(rest[1] ? { market: rest[1] } : {}),
    ...(lens ? { lens } : {}),
  };
};

/** A path segment as written, or as it came where it was not encoded. */
const decode = (segment: string): string => {
  try { return decodeURIComponent(segment); } catch { return segment; }
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

  return (
    <Group justify="space-between" align="center" mb="lg">
      <Breadcrumbs separator="/">{here}</Breadcrumbs>
      <LensPicker route={route} />
    </Group>
  );
};

/**
 * Which lens the contents are seen through — every list and count below it
 * narrows to what the lens lets through. Cleared, it is the whole catalog.
 */
const LensPicker = ({ route }: { route: Route }) => {
  const lenses = useAsk<{ items: Lens[] }>('/lenses', catalog);

  return (
    <Select
      size="xs" w={220} placeholder="Whole catalog" clearable
      data={(lenses.data?.items ?? []).map(one => ({ value: one.slug, label: one.name || one.slug }))}
      value={route.lens ?? null}
      onChange={lens => {
        location.hash = linkTo({ section: 'contents', venue: route.venue, market: route.market, lens: lens ?? undefined }).slice(1);
      }}
    />
  );
};
