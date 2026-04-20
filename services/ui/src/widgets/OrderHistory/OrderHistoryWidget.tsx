import { orderHistoryData } from '../../data/mockData';

const statusClass: Record<string, string> = {
  filled:   'orders__status--filled',
  canceled: 'orders__status--cancelled',
  cancelled:'orders__status--cancelled',
};

export function OrderHistoryWidget() {
  return (
    <section className="widget">
      <div className="widget__header">
        <span className="widget__title">Order History</span>
      </div>
      <div className="widget__body">
        {orderHistoryData.length === 0 ? (
          <div className="widget__empty">No history</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Symbol</th>
                <th>Side</th>
                <th>Price</th>
                <th>Filled / Qty</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {orderHistoryData.map((order, i) => (
                <tr key={i}>
                  <td style={{ fontWeight: 600 }}>{order.symbol}</td>
                  <td style={{ color: order.side === 'Buy' ? 'var(--Buy-Primary)' : 'var(--Sell-Primary)', fontWeight: 600 }}>{order.side}</td>
                  <td>${order.price.toLocaleString('en-US', { minimumFractionDigits: 1 })}</td>
                  <td>{order.filled} / {order.quantity}</td>
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
