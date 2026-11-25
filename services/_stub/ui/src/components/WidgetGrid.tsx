import { useCallback, useEffect, useState } from 'react';
import { GridLayout, type Layout, useContainerWidth } from 'react-grid-layout';
import 'react-grid-layout/css/styles.css';

import { ChartWidget }        from '../widgets/Chart/ChartWidget';
import { DepthChartWidget }   from '../widgets/DepthChart/DepthChartWidget';
import { MarginWidget }       from '../widgets/Margin/MarginWidget';
import { OrderHistoryWidget } from '../widgets/OrderHistory/OrderHistoryWidget';
import { OrderbookWidget }    from '../widgets/Orderbook/OrderbookWidget';
import { OrdersWidget }       from '../widgets/Orders/OrdersWidget';
import { PositionsWidget }    from '../widgets/Positions/PositionsWidget';
import { RecentTradesWidget } from '../widgets/RecentTrades/RecentTradesWidget';
import { TradeHistoryWidget } from '../widgets/TradeHistory/TradeHistoryWidget';
import { get, set } from '../utils/storage';

const COLS        = 12;
/** Grid rows that fill the container's height; the row height is derived from it. */
const ROWS        = 12;
const STORAGE_KEY = 'tradebot.ui.layout';

const DEFAULT_LAYOUT: Layout = [
  { i: 'chart',        x: 0,  y: 0, w: 5, h: 8,  minW: 2, minH: 3 },
  { i: 'orderbook',    x: 5,  y: 0, w: 2, h: 8,  minW: 2, minH: 3 },
  { i: 'recenttrades', x: 7,  y: 0, w: 2, h: 8,  minW: 2, minH: 3 },
  { i: 'depthchart',   x: 9,  y: 0, w: 2, h: 5,  minW: 2, minH: 3 },
  { i: 'margin',       x: 9,  y: 5, w: 2, h: 3,  minW: 2, minH: 2 },
  { i: 'positions',    x: 0,  y: 8, w: 4, h: 4,  minW: 2, minH: 2 },
  { i: 'orders',       x: 4,  y: 8, w: 3, h: 4,  minW: 2, minH: 2 },
  { i: 'orderhistory', x: 7,  y: 8, w: 3, h: 4,  minW: 2, minH: 2 },
  { i: 'tradehistory', x: 10, y: 8, w: 2, h: 4,  minW: 2, minH: 2 },
];

/** True when `v` is a list of grid items: a string key and finite x/y/w/h each. */
function isLayout(v: unknown): v is Layout {
  return Array.isArray(v) && v.every(item => {
    const it = item as Record<string, unknown> | null;

    return typeof it === 'object' && it !== null
      && typeof it.i === 'string'
      && [it.x, it.y, it.w, it.h].every(Number.isFinite);
  });
}

/** The saved layout, or DEFAULT_LAYOUT when none is saved or the saved value is not a layout. */
function loadLayout(): Layout {
  const stored = get<unknown>(STORAGE_KEY, null);

  return isLayout(stored) ? stored : DEFAULT_LAYOUT;
}

export function WidgetGrid() {
  const [layout, setLayout] = useState<Layout>(loadLayout);
  const { width, containerRef, mounted } = useContainerWidth();
  const [rowHeight, setRowHeight] = useState(60);

  useEffect(() => {
    if (! containerRef.current) {
      return;
    }

    const observer = new ResizeObserver(([entry]) => {
      const h = entry.contentRect.height;

      setRowHeight(Math.max(30, Math.floor(h / ROWS)));
    });

    observer.observe(containerRef.current);

    return () => observer.disconnect();
  }, [containerRef]);

  const onLayoutChange = useCallback((next: Layout) => {
    setLayout(next);
    set(STORAGE_KEY, next);
  }, []);

  return (
    <div ref={containerRef} className="widget-grid-container">
      {mounted && (
        <GridLayout
          width={width}
          layout={layout}
          gridConfig={{ cols: COLS, rowHeight }}
          dragConfig={{ handle: '.widget__header' }}
          resizeConfig={{ handles: ['se'] }}
          onLayoutChange={onLayoutChange}
        >
          <div key="chart">        <ChartWidget />        </div>
          <div key="orderbook">    <OrderbookWidget />    </div>
          <div key="recenttrades"> <RecentTradesWidget /> </div>
          <div key="depthchart">   <DepthChartWidget />   </div>
          <div key="margin">       <MarginWidget />       </div>
          <div key="positions">    <PositionsWidget />    </div>
          <div key="orders">       <OrdersWidget />       </div>
          <div key="orderhistory"> <OrderHistoryWidget /> </div>
          <div key="tradehistory"> <TradeHistoryWidget /> </div>
        </GridLayout>
      )}
    </div>
  );
}
