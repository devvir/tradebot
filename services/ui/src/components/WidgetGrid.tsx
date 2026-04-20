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

const COLS       = 12;
const STORAGE_KEY = 'bitmex-widget-layout';

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

function loadLayout(): Layout {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);

    if (raw) {
      return JSON.parse(raw) as Layout;
    }
  } catch {
    // ignore corrupt storage
  }

  return DEFAULT_LAYOUT;
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

      setRowHeight(Math.max(30, Math.floor(h / COLS)));
    });

    observer.observe(containerRef.current);

    return () => observer.disconnect();
  }, [containerRef]);

  const onLayoutChange = useCallback((next: Layout) => {
    setLayout(next);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
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
