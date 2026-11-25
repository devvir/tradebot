import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { DEFAULT_SYMBOL, useSymbol } from '../../src/utils/useSymbol';

function at(path: string) {
  return ({ children }: { children: ReactNode }) => (
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path=":symbol" element={children} />
        <Route path="*"       element={children} />
      </Routes>
    </MemoryRouter>
  );
}

describe('useSymbol', () => {
  it('returns the symbol from the route', () => {
    const { result } = renderHook(() => useSymbol(), { wrapper: at('/ETHUSD') });

    expect(result.current).toBe('ETHUSD');
  });

  it('falls back to the default symbol outside a /:symbol route', () => {
    const { result } = renderHook(() => useSymbol(), { wrapper: at('/') });

    expect(result.current).toBe(DEFAULT_SYMBOL);
    expect(DEFAULT_SYMBOL).toBe('XBTUSD');
  });
});
