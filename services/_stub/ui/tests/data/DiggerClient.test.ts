import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DiggerClient } from '../../src/data/DiggerClient';

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('DiggerClient.setClock', () => {
  it('POSTs to /set-clock with the timestamp in the query string', async () => {
    const f = vi.fn().mockResolvedValueOnce({ ok: true } as Response);
    vi.stubGlobal('fetch', f);

    const client = new DiggerClient('/replay');

    await client.setClock(1_700_000_000_000);

    expect(f).toHaveBeenCalledWith('/replay/set-clock?timestamp=1700000000000', { method: 'POST' });
  });

  it('resolves on a 2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: true } as Response));

    const client = new DiggerClient('/replay');

    await expect(client.setClock(1)).resolves.toBeUndefined();
  });

  it('throws with status code when the response is non-OK', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
      ok:     false,
      status: 503,
      text:   () => Promise.resolve(''),
    } as Response));

    const client = new DiggerClient('/replay');

    await expect(client.setClock(1)).rejects.toThrow(/503/);
  });

  it('appends the upstream error body to the thrown message when present', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
      ok:     false,
      status: 500,
      text:   () => Promise.resolve('clock too far in the future'),
    } as Response));

    const client = new DiggerClient('/replay');

    await expect(client.setClock(1)).rejects.toThrow(/clock too far in the future/);
  });

  it('still throws cleanly when .text() rejects', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
      ok:     false,
      status: 502,
      text:   () => Promise.reject(new Error('stream closed')),
    } as Response));

    const client = new DiggerClient('/replay');

    await expect(client.setClock(1)).rejects.toThrow(/502/);
  });
});
