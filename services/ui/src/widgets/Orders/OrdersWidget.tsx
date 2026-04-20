import { activeOrdersData } from '../../data/mockData';

const statusClass: Record<string, string> = {
  open: 'orders__status--open',
  filled: 'orders__status--filled',
  cancelled: 'orders__status--cancelled',
  partiallyfilled: 'orders__status--partiallyfilled',
};

export function OrdersWidget() {
  return (
    <section className="widget">
      <div className="widget__header">
        <span className="widget__title">Active Orders</span>
      </div>
      <div className="widget__body">
        {activeOrdersData.length === 0 ? (
          <div className="widget__empty">No active orders</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Symbol</th>
                <th>Side</th>
                <th>Price</th>
                <th>Qty</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {activeOrdersData.map((order, i) => (
                <tr key={i}>
                  <td style={{ fontWeight: 600 }}>{order.symbol}</td>
                  <td style={{ color: order.side === 'Buy' ? 'var(--Buy-Primary)' : 'var(--Sell-Primary)', fontWeight: 600 }}>{order.side}</td>
                  <td>${order.price.toLocaleString('en-US', { minimumFractionDigits: 1 })}</td>
                  <td>{order.quantity.toLocaleString()}</td>
                  <td className={statusClass[order.status.toLowerCase()] ?? ''}>{order.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}
