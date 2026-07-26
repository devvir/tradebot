import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App from '../src/App';

/** Stub the BitmexClient so the real DataProvider doesn't open a WebSocket. */
vi.mock('../src/data/BitmexClient', () => ({
  BitmexClient: class {
    fetch  = vi.fn(async () => []);
    stream = vi.fn(() => () => {});
    destroy = vi.fn();
  },
}));

vi.mock('../src/data/DiggerClient', () => ({
  DiggerClient: class { constructor(public baseUrl: string) {} },
}));

beforeEach(() => {
  localStorage.clear();
});

describe('App routing', () => {
  it('renders the MarketView for /XBTUSD', () => {
    render(
      <MemoryRouter initialEntries={['/XBTUSD']}>
        <App />
      </MemoryRouter>,
    );

    /** ContractBar's ticker class is unique to the contract picker — proves the shell rendered. */
    expect(screen.getAllByText('BTCUSD').length).toBeGreaterThan(0);
  });

  it('redirects from / to /XBTUSD', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>,
    );

    expect(screen.getAllByText('BTCUSD').length).toBeGreaterThan(0);
  });
});
