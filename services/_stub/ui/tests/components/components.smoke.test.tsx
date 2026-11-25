/**
 * Smoke renders for the chrome components — verify they mount without throwing
 * and the most recognisable bit of content is visible.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

import { Header }     from '../../src/components/Header';
import { WidgetGrid } from '../../src/components/WidgetGrid';

beforeEach(() => {
  localStorage.clear();
});

function Router({ children }: { children: ReactNode }) {
  return (
    <MemoryRouter initialEntries={['/XBTUSD']}>
      <Routes>
        <Route path=":symbol" element={children} />
      </Routes>
    </MemoryRouter>
  );
}

describe('Header', () => {
  it('renders the application name', () => {
    render(<Header />);

    expect(screen.getByRole('banner')).toHaveTextContent('TradeBot');
  });
});

describe('WidgetGrid', () => {
  it('mounts and renders all the configured widget keys', () => {
    render(<WidgetGrid />, { wrapper: Router });

    /** A grab-bag of widget titles from the default layout. */
    expect(screen.getByText('Chart')).toBeInTheDocument();
    expect(screen.getByText('Orderbook')).toBeInTheDocument();
    expect(screen.getByText('Positions')).toBeInTheDocument();
    expect(screen.getByText('Active Orders')).toBeInTheDocument();
    expect(screen.getByText('Margin')).toBeInTheDocument();
  });
});
