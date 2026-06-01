/**
 * Smoke renders for the chrome components — verify they mount without throwing
 * and the most recognisable bit of content is visible.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

import { ContractBar } from '../../src/components/ContractBar';
import { Header }      from '../../src/components/Header';
import { Sidebar }     from '../../src/components/Sidebar';
import { WidgetGrid }  from '../../src/components/WidgetGrid';

import { EnvProvider }                  from '../../src/data/EnvProvider';
import { _test_BitmexContext as BitmexContext, _test_DiggerContext as DiggerContext } from '../../src/data/DataProvider';
import { makeFakeBitmex, type FakeBitmex } from '../helpers/fakeBitmex';

let fake: FakeBitmex;

beforeEach(() => {
  localStorage.clear();
  fake = makeFakeBitmex();
  globalThis.__REPLAY_ENABLED__ = true;
});

function FullProviders({ children }: { children: ReactNode }) {
  return (
    <MemoryRouter initialEntries={['/XBTUSD']}>
      <EnvProvider>
        <Routes>
          <Route path=":symbol" element={
            <BitmexContext.Provider value={fake.client}>
              <DiggerContext.Provider value={null}>
                {children}
              </DiggerContext.Provider>
            </BitmexContext.Provider>
          } />
        </Routes>
      </EnvProvider>
    </MemoryRouter>
  );
}

describe('ContractBar', () => {
  it('renders the ticker', () => {
    render(<ContractBar />);

    expect(screen.getByText('BTCUSD')).toBeInTheDocument();
  });
});

describe('Sidebar', () => {
  it('renders the order-type tabs', () => {
    render(<Sidebar />);

    /** All three tabs visible in the initial render. */
    expect(screen.getByText('Limit')).toBeInTheDocument();
    expect(screen.getByText('Market')).toBeInTheDocument();
    expect(screen.getByText('Stop Market')).toBeInTheDocument();
  });
});

describe('Header', () => {
  it('renders the env switcher and login buttons', () => {
    render(<Header />, { wrapper: FullProviders });

    expect(screen.getByRole('combobox', { name: /data environment/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /login/i })).toBeInTheDocument();
  });
});

describe('WidgetGrid', () => {
  it('mounts and renders all the configured widget keys', () => {
    render(<WidgetGrid />, { wrapper: FullProviders });

    /** A grab-bag of widget titles from the default layout. */
    expect(screen.getByText('Positions')).toBeInTheDocument();
    expect(screen.getByText('Active Orders')).toBeInTheDocument();
    expect(screen.getByText('Margin')).toBeInTheDocument();
  });
});
