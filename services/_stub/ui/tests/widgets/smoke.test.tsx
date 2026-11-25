/**
 * Smoke renders for every widget — verifies they mount without throwing and
 * surface a recognisable title. Static widgets render straight from
 * `mockData`; market-data widgets say they have no data source.
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import { ChartWidget }        from '../../src/widgets/Chart/ChartWidget';
import { DepthChartWidget }   from '../../src/widgets/DepthChart/DepthChartWidget';
import { MarginWidget }       from '../../src/widgets/Margin/MarginWidget';
import { OrderHistoryWidget } from '../../src/widgets/OrderHistory/OrderHistoryWidget';
import { OrderbookWidget }    from '../../src/widgets/Orderbook/OrderbookWidget';
import { OrdersWidget }       from '../../src/widgets/Orders/OrdersWidget';
import { PositionsWidget }    from '../../src/widgets/Positions/PositionsWidget';
import { RecentTradesWidget } from '../../src/widgets/RecentTrades/RecentTradesWidget';
import { TradeHistoryWidget } from '../../src/widgets/TradeHistory/TradeHistoryWidget';

// ── Static widgets (mock-data, no context required) ───────────────────────────

describe('Static widgets render', () => {
  it('MarginWidget renders the title', () => {
    render(<MarginWidget />);
    expect(screen.getByText('Margin')).toBeInTheDocument();
  });

  it('DepthChartWidget renders the title', () => {
    const { container } = render(<DepthChartWidget />);

    /** "Depth Chart" appears twice (title + placeholder) — assert on the title node specifically. */
    expect(container.querySelector('.widget__title')?.textContent).toBe('Depth Chart');
  });

  it('OrdersWidget renders the title', () => {
    render(<OrdersWidget />);
    expect(screen.getByText('Active Orders')).toBeInTheDocument();
  });

  it('PositionsWidget renders the title', () => {
    render(<PositionsWidget />);
    expect(screen.getByText('Positions')).toBeInTheDocument();
  });

  it('OrderHistoryWidget renders the title', () => {
    render(<OrderHistoryWidget />);
    expect(screen.getByText('Order History')).toBeInTheDocument();
  });

  it('TradeHistoryWidget renders the title', () => {
    render(<TradeHistoryWidget />);
    expect(screen.getByText('Trade History')).toBeInTheDocument();
  });
});

// ── Market-data widgets ───────────────────────────────────────────────────────

describe('Market-data widgets', () => {
  it('ChartWidget names the route symbol and has no data source', () => {
    render(
      <MemoryRouter initialEntries={['/ETHUSD']}>
        <Routes>
          <Route path=":symbol" element={<ChartWidget />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByText('ETHUSD')).toBeInTheDocument();
    expect(screen.getByText('No data source configured')).toBeInTheDocument();
  });

  it('OrderbookWidget has no data source', () => {
    render(<OrderbookWidget />);

    expect(screen.getByText('Orderbook')).toBeInTheDocument();
    expect(screen.getByText('No data source configured')).toBeInTheDocument();
  });

  it('RecentTradesWidget has no data source', () => {
    render(<RecentTradesWidget />);

    expect(screen.getByText('Recent Trades')).toBeInTheDocument();
    expect(screen.getByText('No data source configured')).toBeInTheDocument();
  });
});
