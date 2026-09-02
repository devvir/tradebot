import { Anchor, Code, Group, Stack } from '@mantine/core';
import { catalog, useAsk } from '../api';
import { Dim, Table, Waiting, count } from './Table';
import { SymbolsPanel } from './Symbols';
import { linkTo } from '../App';
import type { DatasetContents, MarketContents } from '../types';

/**
 * One venue's markets, with what each of them publishes.
 *
 * **The symbols open underneath rather than replacing this.** Which instruments
 * a venue lists is a question somebody has *while* reading the markets table,
 * so answering it by navigating away takes the context with it.
 */
export const VenueView = ({ venue }: { venue: string }) => {
  const asked = useAsk<{ items: MarketContents[] }>(
    `/contents/venues/${encodeURIComponent(venue)}`, catalog);

  return (
    <Waiting asked={asked}>
      {({ items }) => (
        <Stack gap="lg">
          <Table
            caption={`${venue} — Markets`}
            rows={items}
            columns={[
              { head: 'Market', width: '14%', cell: m => (
                <Anchor size="sm" href={linkTo({ venue, market: m.market })}>{m.market}</Anchor>) },
              { head: 'Symbols', width: '12%', num: true, cell: m => count(m.symbols) },
              { head: 'Datasets', width: '74%', cell: m => <Datasets of={m.datasets} /> },
            ]}
          />

          <SymbolsPanel venue={venue} />
        </Stack>
      )}
    </Waiting>
  );
};

// ── Internals ─────────────────────────────────────────────────────────────────

/**
 * **Each dataset carries its own size**, because one number for the market is
 * unreadable: binance perp is 130 shapes, and knowing that tells nobody it is
 * four datasets at fifteen bar lengths filed two ways.
 */
const Datasets = ({ of }: { of: DatasetContents[] }) => of.length === 0
  ? <Dim>—</Dim>
  : (
    <Group gap="xs">
      {of.map(one => (
        <Code key={one.dataset} title={describe(one)}>
          {one.dataset}{one.shapes > 1 ? `·${one.shapes}` : ''}
        </Code>
      ))}
    </Group>
  );

const describe = (one: DatasetContents): string => [
  `${one.shapes} shape${one.shapes === 1 ? '' : 's'}`,
  one.variants.length > 0 ? `variants: ${one.variants.join(', ')}` : 'no variants',
  `filed ${one.grains.join(' and ')}`,
  `${one.symbols.toLocaleString()} symbols`,
].join('\n');
