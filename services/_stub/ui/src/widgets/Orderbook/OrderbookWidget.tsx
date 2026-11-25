import { NoDataSource } from '../NoDataSource';

/** Order book pane. */
export function OrderbookWidget() {
  return (
    <section className="widget">
      <div className="widget__header">
        <span className="widget__title">Orderbook</span>
      </div>
      <div className="widget__body">
        <NoDataSource />
      </div>
    </section>
  );
}
