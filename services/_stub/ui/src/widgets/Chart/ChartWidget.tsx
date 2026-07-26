import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useChart } from './useChart';
import { ChartCanvas } from './ChartCanvas';
import type { Timeframe, Candle } from './types';

const TIMEFRAMES: Timeframe[] = ['1m', '5m', '1h', '1d'];

function fmtPrice(n: number): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

function fmtVolume(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(2) + 'K';

  return n.toLocaleString();
}

function fmtTimestamp(ts: string, timeframe: Timeframe): string {
  const d = new Date(ts);

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

function OhlcBar({ candle, timeframe }: { candle: Candle | null; timeframe: Timeframe }) {
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
        O <span className={up ? 'chart__ohlc-up' : 'chart__ohlc-down'}>{fmtPrice(candle.open)}</span>
      </span>
      <span className="chart__ohlc-item">
        H <span className={up ? 'chart__ohlc-up' : 'chart__ohlc-down'}>{fmtPrice(candle.high)}</span>
      </span>
      <span className="chart__ohlc-item">
        L <span className={up ? 'chart__ohlc-up' : 'chart__ohlc-down'}>{fmtPrice(candle.low)}</span>
      </span>
      <span className="chart__ohlc-item">
        C <span className={up ? 'chart__ohlc-up' : 'chart__ohlc-down'}>{fmtPrice(candle.close)}</span>
      </span>
      <span className="chart__ohlc-item chart__ohlc-vol">
        Vol <span>{fmtVolume(candle.volume)}</span>
      </span>
    </div>
  );
}

export function ChartWidget() {
  const { symbol = 'XBTUSD' } = useParams<{ symbol: string }>();
  const [timeframe, setTimeframe] = useState<Timeframe>('1m');
  const [hovered,   setHovered]   = useState<Candle | null>(null);

  const { candles, viewport, onZoom, onPan } = useChart(timeframe);

  /** Hover takes priority; else show the rightmost visible candle (running in live mode). */
  const infoCandle = hovered ?? candles[candles.length - 1] ?? null;

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
      <OhlcBar candle={infoCandle} timeframe={timeframe} />
      <div className="widget__body chart__body">
        <ChartCanvas
          candles={candles}
          candlesPerView={viewport.candlesPerView}
          onZoom={onZoom}
          onPan={onPan}
          onHover={setHovered}
        />
      </div>
    </section>
  );
}
