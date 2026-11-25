import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App from '../src/App';

beforeEach(() => {
  localStorage.clear();
});

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

/** The symbol the chart is titled with (the mock account widgets name symbols too). */
function chartSymbol(container: HTMLElement): string | null | undefined {
  return container.querySelector('.widget__subtitle')?.textContent;
}

describe('App routing', () => {
  it('renders the market view for the symbol in the route', () => {
    const { container } = renderAt('/ETHUSD');

    expect(chartSymbol(container)).toBe('ETHUSD');
  });

  it('redirects from / to the default symbol', () => {
    const { container } = renderAt('/');

    expect(chartSymbol(container)).toBe('XBTUSD');
  });
});

describe('App shell', () => {
  it('frames the widget grid with a header holding the name alone: no figures, ticker, connection indicator or links', () => {
    const { container } = renderAt('/XBTUSD');
    const shell = container.querySelector('.app-shell');

    expect(screen.getByRole('banner').textContent).toBe('TradeBot');
    expect([...shell!.children].map(el => el.className)).toEqual(['header', 'app-body']);
    expect(shell!.querySelector('.app-body')!.children).toHaveLength(1);
    expect(shell!.querySelector('.app-body > .widget-grid-container')).not.toBeNull();
    expect(screen.queryByText(/online/i)).not.toBeInTheDocument();
    expect(container.querySelector('a')).toBeNull();
  });

  it('says the market-data widgets have no data source', () => {
    renderAt('/XBTUSD');

    /** Chart, Orderbook and Recent Trades. */
    expect(screen.getAllByText('No data source configured')).toHaveLength(3);
  });
});
