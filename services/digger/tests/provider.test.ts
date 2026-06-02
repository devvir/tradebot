import { describe, it, expect, vi } from 'vitest';
import type { FetchClientHandle } from '@devvir/service-kit';
import { Provider } from '../src/provider';
import type { RestParams } from '../src/core/types';

const stub = () => {
  const get = vi.fn(async () => null);

  return { client: { get } as unknown as FetchClientHandle, get };
};

describe('Provider seam — request building', () => {
  it('builds the partial URL', async () => {
    const ws = stub();
    await new Provider(ws.client, stub().client).partial('orderBookL2', 1700000000000);

    expect(ws.get).toHaveBeenCalledWith('/ws/orderBookL2/partial?before=1700000000000');
  });

  it('builds the stream URL', async () => {
    const ws = stub();
    await new Provider(ws.client, stub().client).stream('trade', 42, 1000);

    expect(ws.get).toHaveBeenCalledWith('/ws/trade?after=42&limit=1000');
  });

  it('builds the rest URL with all params', async () => {
    const rest = stub();
    const params: RestParams = { symbol: 'XBTUSD', count: 5, start: 2, reverse: true, startTime: 100, endTime: 200, columns: ['price', 'size'] };

    await new Provider(stub().client, rest.client).records('trade', params);

    const qs = new URLSearchParams((rest.get.mock.calls[0]![0] as string).split('?')[1]);

    expect(qs.get('symbol')).toBe('XBTUSD');
    expect(qs.get('count')).toBe('5');
    expect(qs.get('start')).toBe('2');
    expect(qs.get('reverse')).toBe('true');
    expect(qs.get('startTime')).toBe('100');
    expect(qs.get('endTime')).toBe('200');
    expect(qs.get('columns')).toBe('price,size');
  });

  it('falls back to safe defaults when the provider yields null', async () => {
    const provider = new Provider(stub().client, stub().client);

    expect(await provider.partial('trade', 1)).toEqual({ partial: null, cursor: null });
    expect(await provider.stream('trade', 1, 10)).toEqual({ messages: [], cursor: null, exhausted: true });
    expect(await provider.records('trade', { count: 1, start: 0, reverse: false } as RestParams)).toEqual([]);
  });
});
