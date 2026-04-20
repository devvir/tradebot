import { useParams } from 'react-router-dom';
import { useRecentTrades } from './useRecentTrades';

// Paths from BitMEX's own SVG markup (viewBox 0 0 32 32)
const PATH_UP   = 'M16 4L6 14 7.41 15.41 15 7.83 15 28 17 28 17 7.83 24.59 15.41 26 14 16 4z';
const PATH_DOWN = 'M16 28L6 18 7.41 16.59 15 24.17 15 4 17 4 17 24.17 24.59 16.59 26 18 16 28z';

/**
 * Arrow on PlusTick / MinusTick only — price actually moved from the previous trade.
 * ZeroPlusTick / ZeroMinusTick mean the price is unchanged (Zero = no change), no arrow.
 */
function TickArrow({ direction }: { direction: string }) {
  const up   = direction === 'PlusTick';
  const down = direction === 'MinusTick';

  if (! up && ! down) {
    return null;
  }

  return (
    <svg
      focusable="false"
      preserveAspectRatio="xMidYMid meet"
      fill="currentColor"
      width="14"
      height="14"
      viewBox="0 0 32 32"
      aria-hidden="true"
      className="recenttrades__tick"
    >
      <path d={up ? PATH_UP : PATH_DOWN} />
    </svg>
  );
}

function formatTime(timestamp: string): string {
  return new Date(timestamp).toLocaleTimeString('en-US', { hour12: false });
}

function quoteCurrency(symbol: string): string {
  if (symbol.endsWith('USDT')) return 'USDT';
  if (symbol.endsWith('USD'))  return 'USD';
  if (symbol.endsWith('XBT'))  return 'XBT';
  return symbol.slice(-3);
}

export function RecentTradesWidget() {
  const { symbol = 'XBTUSD' } = useParams<{ symbol: string }>();
  const trades = useRecentTrades();

  return (
    <section className="widget">
      <div className="widget__header">
        <span className="widget__title">Recent Trades</span>
      </div>
      <div className="widget__body">
        {trades.length === 0 ? (
          <div className="widget__empty">Connecting…</div>
        ) : (
          <table className="recenttrades__table">
            <thead>
              <tr>
                <th>Price</th>
                <th className="recenttrades__col--size">Size ({quoteCurrency(symbol)})</th>
                <th>Time</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {trades.map(({ uid, trade }) => (
                <tr
                  key={uid}
                  className={trade.side === 'Buy' ? 'recenttrades__row--buy' : 'recenttrades__row--sell'}
                >
                  <td className="recenttrades__price">
                    <span className="recenttrades__tick-slot">
                      <TickArrow direction={trade.tickDirection} />
                    </span>
                    {trade.price.toLocaleString('en-US', { minimumFractionDigits: 1 })}
                  </td>
                  <td className="recenttrades__col--size">{trade.size.toLocaleString()}</td>
                  <td className="recenttrades__time">{formatTime(trade.timestamp)}</td>
                  <td className="recenttrades__side">{trade.side === 'Buy' ? 'B' : 'S'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}
