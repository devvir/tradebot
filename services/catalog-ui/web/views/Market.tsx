import { useMemo, useState } from 'react';
import { Code, Group, Select, Stack, Text } from '@mantine/core';
import { catalog, useAsk } from '../api';
import { Dim, Span, Table, Waiting, count } from './Table';
import { SymbolsPanel } from './Symbols';
import type { Shape } from '../types';

/**
 * What one market publishes: one row per `(dataset, variant, grain)`.
 *
 * **The spans are the point of this view.** A variant that stopped and the one
 * that replaced it are two rows with adjacent ends — bybit's perpetual books are
 * `500,incremental` to 2025-08-20 and `200,incremental` from the 21st — and
 * seeing that is how somebody decides to fetch both rather than half.
 */
export const MarketView = ({ venue, market }: { venue: string; market: string }) => {
  const at    = `/contents/venues/${encodeURIComponent(venue)}/markets/${encodeURIComponent(market)}`;
  const asked = useAsk<{ items: Shape[] }>(at, catalog);

  return (
    <Stack gap="xl">
      <Waiting asked={asked}>
        {({ items }) => <Shapes venue={venue} market={market} shapes={items} />}
      </Waiting>

      <SymbolsPanel venue={venue} market={market} />
    </Stack>
  );
};

/** The canonical variant string, as the archives spell it — `400,incremental`. */
export const variantOf = (shape: Shape): string => Object.values(shape.variant).join(',');

// ── Internals ─────────────────────────────────────────────────────────────────

/**
 * The rows, and the filters over them.
 *
 * **Every option comes from the rows themselves**, never from a list of what a
 * venue might publish — so a filter can only ever offer something that is
 * actually there, and offers nothing at all where there is nothing to choose
 * between. Filtering happens here rather than at the catalog because the whole
 * answer is already in hand: a market is at most a few hundred rows.
 */
const Shapes = ({ venue, market, shapes }: {
  venue: string; market: string; shapes: Shape[];
}) => {
  const [dataset, setDataset] = useState<string | null>(null);
  const [grain, setGrain]     = useState<string | null>(null);
  const [variant, setVariant] = useState<string | null>(null);

  const datasets = useMemo(() => sorted(shapes.map(one => one.dataset)), [shapes]);
  const grains   = useMemo(() => sorted(shapes.map(one => one.grain)), [shapes]);

  /**
   * **Only the chosen dataset's variants**, because a bar length and a book
   * depth are not alternatives to each other — offering both in one list would
   * invite a combination no row can satisfy.
   */
  const variants = useMemo(() => (dataset === null ? [] : sorted(
    shapes.filter(one => one.dataset === dataset).map(variantOf).filter(Boolean))),
  [shapes, dataset]);

  const kept = useMemo(() => shapes.filter(one =>
    (dataset === null || one.dataset === dataset)
    && (grain === null || one.grain === grain)
    && (variant === null || variantOf(one) === variant)), [shapes, dataset, grain, variant]);

  /** A variant chosen under one dataset means nothing under the next. */
  const pickDataset = (value: string | null) => {
    setDataset(value);
    setVariant(null);
  };

  return (
    <Stack gap="md">
      {/*
        **Grain first, then dataset, then variant.** Variant belongs beside the
        dataset it narrows — it is not a filter of its own, it is the second half
        of that one — and putting grain to the left of the pair means grain never
        moves as variant appears and disappears.
      */}
      <Group gap="sm" align="flex-end">
        <Select
          label="Grain" placeholder="Any" size="xs" w={120} clearable
          data={grains} value={grain} onChange={setGrain}
        />

        <Select
          label="Dataset" placeholder="Any" size="xs" w={180} clearable
          data={datasets} value={dataset} onChange={pickDataset}
        />

        {/*
          **Shown only where there is a choice to make.** One variant is not a
          filter, it is a fact about the dataset — and a dataset with none at all
          (trades, funding) would offer an empty list.
        */}
        {variants.length > 1 && (
          <Select
            label="Variant" placeholder="Any" size="xs" w={200} clearable
            data={variants} value={variant} onChange={setVariant}
          />
        )}

        {kept.length !== shapes.length && (
          <Text size="xs" c="dimmed" pb={6}>
            {kept.length} of {shapes.length}
          </Text>
        )}
      </Group>

      <Table
        caption={`${venue} ${market} — What it publishes`}
        rows={kept}
        empty="Nothing matches those filters"
        columns={[
          { head: 'Dataset', width: '18%', cell: s => s.dataset },
          { head: 'Variant', width: '26%', cell: s => {
            const levels = Object.entries(s.variant);

            return levels.length === 0 ? <Dim>—</Dim>
              : <Code>{levels.map(([level, value]) => `${level}=${value}`).join(' ')}</Code>;
          } },
          { head: 'Grain', width: '10%', cell: s => s.grain },
          { head: 'Symbols', width: '10%', num: true, cell: s => count(s.symbols) },
          { head: 'Buckets', width: '10%', num: true, cell: s => s.buckets || '' },
          { head: 'Span', width: '26%', cell: s => <Span first={s.first} last={s.last} open={s.open} /> },
        ]}
      />
    </Stack>
  );
};

const sorted = (values: string[]): string[] => [...new Set(values)].sort();
