/**
 * Body of a market-data widget: the UI has no data source, so the widget says
 * so instead of showing figures.
 */
export function NoDataSource() {
  return <div className="widget__empty">No data source configured</div>;
}
