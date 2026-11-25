import { useSymbol } from '../../utils/useSymbol';
import { NoDataSource } from '../NoDataSource';

/** Chart pane for the route's symbol. */
export function ChartWidget() {
  const symbol = useSymbol();

  return (
    <section className="widget">
      <div className="widget__header">
        <span className="widget__title">
          Chart <span className="widget__subtitle">{symbol}</span>
        </span>
      </div>
      <div className="widget__body">
        <NoDataSource />
      </div>
    </section>
  );
}
