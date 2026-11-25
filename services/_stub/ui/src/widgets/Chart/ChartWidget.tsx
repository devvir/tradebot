import { useMemo, useState } from 'react';
import { useChart } from './useChart';
import { ChartCanvas } from './ChartCanvas';
import { BIN_MS } from './types';
import type { Timeframe, Candle } from './types';
import { fmtPrice, priceDecimals } from '../../utils/format';
import { useSymbol } from '../../utils/useSymbol';

const TIMEFRAMES: Timeframe[] = ['1m', '5m', '1h', '1d'];

function fmtVolume(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(2) + 'K';

  return n.toLocaleString();
}

/**
 * Label for a candle: its bin's open time. A candle's `timestamp` is the bin's
 * close time, so the daily candle covering Nov 23 reads "Nov 23", not "Nov 24".
 */
function fmtTimestamp(ts: string, timeframe: Timeframe): string {
  const d = new Date(new Date(ts).getTime() - BIN_MS[timeframe]);

  if (timeframe === '1d') {
    return d.toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
    });
  }

  return d.toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    hour12: false, timeZone: 'UTC',
  });
}

interface OhlcBarProps {
  candle:    Candle | null;
  timeframe: Timeframe;
  /** Fraction digits for the O/H/L/C prices. */
  decimals:  number;
}

function OhlcBar({ candle, timeframe, decimals }: OhlcBarProps) {
  if (! candle) {
    return <div className="chart__ohlc" />;
  }

  const up = candle.close >= candle.open;

  return (
    <div className="chart__ohlc">
      <span className="chart__ohlc-item chart__ohlc-time">
        {fmtTimestamp(candle.timestamp, timeframe)}
      </span>
      <span className="chart__ohlc-item">
        O <span className={up ? 'chart__ohlc-up' : 'chart__ohlc-down'}>{fmtPrice(candle.open, decimals)}</span>
      </span>
      <span className="chart__ohlc-item">
        H <span className={up ? 'chart__ohlc-up' : 'chart__ohlc-down'}>{fmtPrice(candle.high, decimals)}</span>
      </span>
      <span className="chart__ohlc-item">
        L <span className={up ? 'chart__ohlc-up' : 'chart__ohlc-down'}>{fmtPrice(candle.low, decimals)}</span>
      </span>
      <span className="chart__ohlc-item">
        C <span className={up ? 'chart__ohlc-up' : 'chart__ohlc-down'}>{fmtPrice(candle.close, decimals)}</span>
      </span>
      <span className="chart__ohlc-item chart__ohlc-vol">
        Vol <span>{fmtVolume(candle.volume)}</span>
      </span>
    </div>
  );
}

export function ChartWidget() {
  const symbol = useSymbol();
  const [timeframe, setTimeframe] = useState<Timeframe>('1m');
  const [hoverIdx,  setHoverIdx]  = useState<number | null>(null);

  const { candles, viewport, onZoom, onPan } = useChart(timeframe);

  /**
   * Hover takes priority; else show the rightmost visible candle (running in live mode).
   * Read from the current candles so the readout follows updates under the cursor.
   */
  const infoCandle = (hoverIdx !== null ? candles[hoverIdx] : undefined)
    ?? candles[candles.length - 1]
    ?? null;

  /** One decimal count for every candle on screen, so the readout does not jitter between candles. */
  const decimals = useMemo(
    () => priceDecimals(candles.flatMap(c => [c.open, c.high, c.low, c.close])),
    [candles],
  );

  return (
    <section className="widget">
      <div className="widget__header">
        <span className="widget__title">
          Chart <span className="widget__subtitle">{symbol}</span>
        </span>
        <div className="chart__timeframes">
          {TIMEFRAMES.map(tf => (
            <button
              key={tf}
              className={`chart__tf-btn${tf === timeframe ? ' chart__tf-btn--active' : ''}`}
              onClick={() => setTimeframe(tf)}
            >
              {tf}
            </button>
          ))}
        </div>
      </div>
      <OhlcBar candle={infoCandle} timeframe={timeframe} decimals={decimals} />
      <div className="widget__body chart__body">
        <ChartCanvas
          candles={candles}
          candlesPerView={viewport.candlesPerView}
          binMs={BIN_MS[timeframe]}
          onZoom={onZoom}
          onPan={onPan}
          onHover={setHoverIdx}
        />
      </div>
    </section>
  );
}
