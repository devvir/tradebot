import { NoDataSource } from '../NoDataSource';

/** Recent trades pane. */
export function RecentTradesWidget() {
  return (
    <section className="widget">
      <div className="widget__header">
        <span className="widget__title">Recent Trades</span>
      </div>
      <div className="widget__body">
        <NoDataSource />
      </div>
    </section>
  );
}
