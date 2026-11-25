/**
 * WidgetGrid persists its layout: it restores a saved layout, falls back to
 * the default when the saved value is not a layout, and saves every change
 * (react-grid-layout reports the layout once on mount).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

import { WidgetGrid } from '../../src/components/WidgetGrid';
import { _test_BitmexContext as BitmexContext } from '../../src/data/DataProvider';
import { makeFakeBitmex } from '../helpers/fakeBitmex';

const STORAGE_KEY = 'bitmex-widget-layout';

function Providers({ children }: { children: ReactNode }) {
  const fake = makeFakeBitmex();

  return (
    <MemoryRouter initialEntries={['/XBTUSD']}>
      <Routes>
        <Route path=":symbol" element={
          <BitmexContext.Provider value={fake.client}>{children}</BitmexContext.Provider>
        } />
      </Routes>
    </MemoryRouter>
  );
}

function savedItem(key: string): Record<string, unknown> | undefined {
  const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as Record<string, unknown>[];

  return saved.find(item => item.i === key);
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('WidgetGrid layout persistence', () => {
  it('restores a saved layout', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([{ i: 'chart', x: 7, y: 0, w: 5, h: 8 }]));

    render(<WidgetGrid />, { wrapper: Providers });

    expect(savedItem('chart')).toMatchObject({ x: 7, y: 0, w: 5, h: 8 });
  });

  it.each([
    ['an object', '{"a":1}'],
    ['items without a key', '[{"x":0,"y":0,"w":1,"h":1}]'],
    ['items with non-numeric geometry', '[{"i":"chart","x":"0","y":0,"w":5,"h":8}]'],
    ['malformed JSON', '{not json'],
  ])('falls back to the default layout when the saved value is %s', (_label, raw) => {
    localStorage.setItem(STORAGE_KEY, raw);

    render(<WidgetGrid />, { wrapper: Providers });

    expect(savedItem('chart')).toMatchObject({ x: 0, y: 0, w: 5, h: 8 });
    expect(savedItem('tradehistory')).toMatchObject({ x: 10, y: 8, w: 2, h: 4 });
  });

  it('keeps rendering when the layout cannot be saved', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota exceeded', 'QuotaExceededError');
    });

    render(<WidgetGrid />, { wrapper: Providers });

    expect(setItem).toHaveBeenCalled();
    expect(screen.getByText('Positions')).toBeInTheDocument();
  });
});
