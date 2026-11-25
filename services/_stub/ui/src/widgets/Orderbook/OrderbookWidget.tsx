import { useOrderbook } from './useOrderbook';
import type { OrderbookRow } from './useOrderbook';
import { fmtPrice, priceDecimals, quoteCurrency } from '../../utils/format';
import { useSymbol } from '../../utils/useSymbol';

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

/**
 * Prices and the spread share one decimal count: the most any visible level's
 * price needs, so the columns line up and sub-unit instruments keep their digits.
 */
function SideBySideLayout({ asks, bids, bestAsk, bestBid, spread, currency }: SideBySideProps) {
  const decimals  = priceDecimals([...asks, ...bids].map(row => row.price));
  const spreadPct = bestAsk && bestBid
    ? ((spread / bestAsk) * 100).toFixed(3)
    : '—';

  return (
    <>
      <div className="orderbook__price-bar">
        <span className="orderbook__price-bar__ask">
          {bestAsk ? fmtPrice(bestAsk, decimals) : '—'}
        </span>
        <span className="orderbook__price-bar__spread">
          {spread > 0 ? `${fmtPrice(spread, decimals)} (${spreadPct}%)` : '—'}
        </span>
        <span className="orderbook__price-bar__bid">
          {bestBid ? fmtPrice(bestBid, decimals) : '—'}
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
                  <td className="orderbook__col--price orderbook__price--ask">{fmtPrice(row.price, decimals)}</td>
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
                  <td className="orderbook__col--price orderbook__price--bid">{fmtPrice(row.price, decimals)}</td>
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

export function OrderbookWidget() {
  const symbol = useSymbol();
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
        ) : (
          <SideBySideLayout
            asks={asks}
            bids={bids}
            bestAsk={bestAsk}
            bestBid={bestBid}
            spread={spread}
            currency={currency}
          />
        )}
      </div>
    </section>
  );
}
