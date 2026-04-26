import { describe, it, expect, beforeEach } from 'vitest';
import * as snapshots from '../src/snapshots';
import type { WsMessage } from '../src/types';

beforeEach(() => { snapshots._test_reset(); });

const partial = (data: Array<Record<string, unknown>>): WsMessage => ({
  table:  'instrument',
  action: 'partial',
  data,
  keys:   ['symbol'],
  types:  { symbol: 'symbol', lastPrice: 'float' },
  filter: {},
});

describe('snapshots — cold accumulator', () => {
  it('buildSnapshot returns null when nothing has been fed', () => {
    expect(snapshots.buildSnapshot('instrument')).toBeNull();
  });
});

describe('snapshots — feed + buildSnapshot', () => {
  it('returns the schema and data after a partial is fed', () => {
    snapshots.feed(partial([{ symbol: 'XBTUSD', lastPrice: 50_000 }]));

    const view = snapshots.buildSnapshot('instrument');

    expect(view).not.toBeNull();
    expect(view!.table).toBe('instrument');
    expect(view!.action).toBe('partial');
    expect(view!.keys).toContain('symbol');
    expect(view!.data).toHaveLength(1);
  });

  it('updates merge into the existing keyed state', () => {
    snapshots.feed(partial([{ symbol: 'XBTUSD', lastPrice: 50_000 }]));

    snapshots.feed({
      table:  'instrument',
      action: 'update',
      data:   [{ symbol: 'XBTUSD', lastPrice: 51_000 }],
    });

    const view = snapshots.buildSnapshot('instrument');

    expect(view!.data).toHaveLength(1);
    expect((view!.data[0] as Record<string, unknown>)['lastPrice']).toBe(51_000);
  });

  it('different tables stay isolated', () => {
    snapshots.feed(partial([{ symbol: 'XBTUSD' }]));

    expect(snapshots.buildSnapshot('instrument')).not.toBeNull();
    expect(snapshots.buildSnapshot('orderBookL2')).toBeNull();
  });
});

describe('snapshots — reset', () => {
  it('drops all accumulated state', () => {
    snapshots.feed(partial([{ symbol: 'XBTUSD' }]));
    expect(snapshots.buildSnapshot('instrument')).not.toBeNull();

    snapshots.reset();

    expect(snapshots.buildSnapshot('instrument')).toBeNull();
  });
});
