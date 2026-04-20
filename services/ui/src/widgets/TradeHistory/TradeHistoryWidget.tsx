import { tradeHistoryData } from '../../data/mockData';

export function TradeHistoryWidget() {
  return (
    <section className="widget">
      <div className="widget__header">
        <span className="widget__title">Trade History</span>
      </div>
      <div className="widget__body">
        {tradeHistoryData.length === 0 ? (
          <div className="widget__empty">No trades</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Symbol</th>
                <th>Side</th>
                <th>Price</th>
                <th>Qty</th>
                <th>PnL</th>
              </tr>
            </thead>
            <tbody>
              {tradeHistoryData.map((trade, i) => (
                <tr key={i}>
                  <td style={{ fontWeight: 600 }}>{trade.symbol}</td>
                  <td style={{ color: trade.side === 'Buy' ? 'var(--Buy-Primary)' : 'var(--Sell-Primary)', fontWeight: 600 }}>{trade.side}</td>
                  <td>${trade.price.toLocaleString('en-US', { minimumFractionDigits: 1 })}</td>
                  <td>{trade.quantity.toLocaleString()}</td>
                  <td style={{ color: trade.pnl >= 0 ? 'var(--Buy-Primary)' : 'var(--Sell-Primary)', fontWeight: 600 }}>
                    ${trade.pnl.toFixed(2)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}
