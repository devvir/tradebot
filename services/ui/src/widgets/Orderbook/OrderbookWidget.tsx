import { useParams } from 'react-router-dom';
import { useOrderbook } from './useOrderbook';
import type { OrderbookRow } from './useOrderbook';

/**
 * When true, bids and asks are shown side-by-side (asks left | bids right).
 * Set to false for the classic stacked layout (asks above, bids below).
 */
const SIDE_BY_SIDE = true;

function quoteCurrency(symbol: string): string {
  if (symbol.endsWith('USDT')) return 'USDT';
  if (symbol.endsWith('USD'))  return 'USD';
  if (symbol.endsWith('XBT'))  return 'XBT';
  return symbol.slice(-3);
}

function fmtPrice(price: number): string {
  return price.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

function fmtSize(size: number): string {
  return size.toLocaleString();
}

interface SideBySideProps {
  asks:     OrderbookRow[];
  bids:     OrderbookRow[];
  bestAsk:  number;
  bestBid:  number;
  spread:   number;
  currency: string;
}

function SideBySideLayout({ asks, bids, bestAsk, bestBid, spread, currency }: SideBySideProps) {
  const spreadPct = bestAsk && bestBid
    ? ((spread / bestAsk) * 100).toFixed(3)
    : '—';

  return (
    <>
      <div className="orderbook__price-bar">
        <span className="orderbook__price-bar__ask">
          {bestAsk ? fmtPrice(bestAsk) : '—'}
        </span>
        <span className="orderbook__price-bar__spread">
          {spread > 0 ? `${spread.toFixed(1)} (${spreadPct}%)` : '—'}
        </span>
        <span className="orderbook__price-bar__bid">
          {bestBid ? fmtPrice(bestBid) : '—'}
        </span>
      </div>

      <div className="orderbook__sbs">
        <div className="orderbook__half orderbook__half--asks">
          <table className="orderbook__table">
            <thead>
              <tr>
                <th className="orderbook__col--total">Total</th>
                <th className="orderbook__col--size">Size ({currency})</th>
                <th className="orderbook__col--price">Price</th>
              </tr>
            </thead>
            <tbody>
              {asks.map(row => (
                <tr key={row.price} className="orderbook__row--ask">
                  <td className="orderbook__col--total">{fmtSize(row.total)}</td>
                  <td className="orderbook__col--size">{fmtSize(row.size)}</td>
                  <td className="orderbook__col--price orderbook__price--ask">{fmtPrice(row.price)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="orderbook__half orderbook__half--bids">
          <table className="orderbook__table">
            <thead>
              <tr>
                <th className="orderbook__col--price">Price</th>
                <th className="orderbook__col--size">Size ({currency})</th>
                <th className="orderbook__col--total">Total</th>
              </tr>
            </thead>
            <tbody>
              {bids.map(row => (
                <tr key={row.price} className="orderbook__row--bid">
                  <td className="orderbook__col--price orderbook__price--bid">{fmtPrice(row.price)}</td>
                  <td className="orderbook__col--size">{fmtSize(row.size)}</td>
                  <td className="orderbook__col--total">{fmtSize(row.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

interface StackedProps {
  asks:     OrderbookRow[];
  bids:     OrderbookRow[];
  spread:   number;
  currency: string;
}

function StackedLayout({ asks, bids, spread, currency }: StackedProps) {
  return (
    <table className="orderbook__table orderbook__table--stacked">
      <thead>
        <tr>
          <th>Price</th>
          <th>Size ({currency})</th>
          <th>Total</th>
        </tr>
      </thead>
      <tbody>
        {asks.map(row => (
          <tr key={`ask-${row.price}`} className="orderbook__row--ask">
            <td className="orderbook__price--ask">{fmtPrice(row.price)}</td>
            <td>{fmtSize(row.size)}</td>
            <td>{fmtSize(row.total)}</td>
          </tr>
        ))}
        <tr>
          <td colSpan={3} className="orderbook__spread">
            Spread {spread > 0 ? spread.toFixed(1) : '—'}
          </td>
        </tr>
        {bids.map(row => (
          <tr key={`bid-${row.price}`} className="orderbook__row--bid">
            <td className="orderbook__price--bid">{fmtPrice(row.price)}</td>
            <td>{fmtSize(row.size)}</td>
            <td>{fmtSize(row.total)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function OrderbookWidget() {
  const { symbol = 'XBTUSD' } = useParams<{ symbol: string }>();
  const { asks, bids, bestAsk, bestBid, spread } = useOrderbook();
  const currency = quoteCurrency(symbol);
  const loading  = asks.length === 0 && bids.length === 0;

  return (
    <section className="widget">
      <div className="widget__header">
        <span className="widget__title">Orderbook</span>
      </div>
      <div className="widget__body orderbook__body">
        {loading ? (
          <div className="widget__empty">Connecting…</div>
        ) : SIDE_BY_SIDE ? (
          <SideBySideLayout
            asks={asks}
            bids={bids}
            bestAsk={bestAsk}
            bestBid={bestBid}
            spread={spread}
            currency={currency}
          />
        ) : (
          <StackedLayout asks={asks} bids={bids} spread={spread} currency={currency} />
        )}
      </div>
    </section>
  );
}
