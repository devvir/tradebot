import { describe, it, expect, vi } from 'vitest';
import type { FetchClientHandle } from '@devvir/service-kit';
import { Librarian } from '../src/librarian';

/** A fetch-client stub recording the path it was asked for. */
const stub = (docs: unknown[] = []) => {
  const get = vi.fn(async () => ({ docs }));

  return { client: { get } as unknown as FetchClientHandle, get };
};

describe('Librarian — request building', () => {
  it('builds a bare read with no params', async () => {
    const { client, get } = stub([{ _id: 1 }]);

    const out = await new Librarian(client).read('trade');

    expect(get).toHaveBeenCalledWith('/trade?');
    expect(out).toEqual([{ _id: 1 }]);
  });

  it('encodes from/before/order/limit/filter', async () => {
    const { client, get } = stub();

    await new Librarian(client).read('orderBookL2', {
      from: 10, before: 90, order: 'desc', limit: 5, filter: { action: 'partial' },
    });

    const path = get.mock.calls[0]![0] as string;
    const qs   = new URLSearchParams(path.split('?')[1]);

    expect(qs.get('from')).toBe('10');
    expect(qs.get('before')).toBe('90');
    expect(qs.get('order')).toBe('desc');
    expect(qs.get('limit')).toBe('5');
    expect(JSON.parse(qs.get('filter')!)).toEqual({ action: 'partial' });
  });

  it('returns [] when librarian yields null (passThrough)', async () => {
    const get    = vi.fn(async () => null);
    const client = { get } as unknown as FetchClientHandle;

    expect(await new Librarian(client).read('trade')).toEqual([]);
  });

  it('latestBefore issues a single descending read', async () => {
    const { client, get } = stub([{ _id: 73, action: 'partial' }]);

    const doc = await new Librarian(client).latestBefore('orderBookL2', 73, { action: 'partial' });

    const qs = new URLSearchParams((get.mock.calls[0]![0] as string).split('?')[1]);

    expect(qs.get('before')).toBe('73');
    expect(qs.get('order')).toBe('desc');
    expect(qs.get('limit')).toBe('1');
    expect(doc).toEqual({ _id: 73, action: 'partial' });
  });
});
