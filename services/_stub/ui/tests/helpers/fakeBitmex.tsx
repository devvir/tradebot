/**
 * Test harness that swaps in a controllable BitmexClient. Tests construct a
 * fake, render their hook/widget under a router + provider, then drive the
 * fake's `fetch` resolutions and `stream` emissions directly — no WebSocket
 * or HTTP touched.
 */

import { type ReactNode } from 'react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { vi } from 'vitest';
import { BitmexClient } from '../../src/data/BitmexClient';
import { _test_BitmexContext as BitmexContext } from '../../src/data/DataProvider';

export type StreamAction = 'partial' | 'insert' | 'update' | 'delete';

export interface FakeBitmex {
  client:          BitmexClient;
  fetchMock:       ReturnType<typeof vi.fn>;
  streamMock:      ReturnType<typeof vi.fn>;
  emit:            <T>(channel: string, action: StreamAction, data: T[]) => void;
  subscriberCount: (channel: string) => number;
}

export function makeFakeBitmex(): FakeBitmex {
  const channels: Map<string, Set<(a: StreamAction, d: unknown[]) => void>> = new Map();

  const fetchMock = vi.fn(async () => []);

  const streamMock = vi.fn((channel: string, handler: (a: StreamAction, d: unknown[]) => void) => {
    if (! channels.has(channel)) channels.set(channel, new Set());
    channels.get(channel)!.add(handler);

    return () => {
      channels.get(channel)?.delete(handler);
      if (channels.get(channel)?.size === 0) channels.delete(channel);
    };
  });

  /** Stub a dummy instance — avoids opening a real WS. */
  const client = Object.create(BitmexClient.prototype) as BitmexClient;
  Object.assign(client, {
    fetch:   fetchMock,
    stream:  streamMock,
    destroy: vi.fn(),
  });

  return {
    client,
    fetchMock,
    streamMock,
    emit: (channel, action, data) => {
      channels.get(channel)?.forEach(h => h(action, data));
    },
    subscriberCount: (channel) => channels.get(channel)?.size ?? 0,
  };
}

/** Wrapper for renderHook / render — sets up MemoryRouter + BitmexContext. */
export function makeBitmexWrapper(fake: FakeBitmex, symbol: string = 'XBTUSD') {
  return ({ children }: { children: ReactNode }) => (
    <MemoryRouter initialEntries={[`/${symbol}`]}>
      <Routes>
        <Route path=":symbol" element={
          <BitmexContext.Provider value={fake.client}>{children}</BitmexContext.Provider>
        } />
      </Routes>
    </MemoryRouter>
  );
}
