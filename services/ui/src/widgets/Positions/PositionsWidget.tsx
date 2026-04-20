import { positionsData } from '../../data/mockData';

export function PositionsWidget() {
  return (
    <section className="widget">
      <div className="widget__header">
        <span className="widget__title">Positions</span>
      </div>
      <div className="widget__body">
        {positionsData.length === 0 ? (
          <div className="widget__empty">No open positions</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Symbol</th>
                <th>Side</th>
                <th>Size</th>
                <th>Entry</th>
                <th>PnL</th>
                <th>Liq.</th>
              </tr>
            </thead>
            <tbody>
              {positionsData.map((pos, i) => (
                <tr key={i} className={pos.side === 'Long' ? 'positions__row--long' : 'positions__row--short'}>
                  <td style={{ fontWeight: 600 }}>{pos.symbol}</td>
                  <td style={{ color: pos.side === 'Long' ? 'var(--Buy-Primary)' : 'var(--Sell-Primary)' }}>{pos.side}</td>
                  <td>{pos.size.toLocaleString()}</td>
                  <td>${pos.entryPrice.toFixed(1)}</td>
                  <td style={{ color: pos.unrealizedPnl >= 0 ? 'var(--Buy-Primary)' : 'var(--Sell-Primary)', fontWeight: 600 }}>
                    ${pos.unrealizedPnl.toFixed(2)}
                    <span style={{ fontSize: 10, opacity: 0.7 }}> ({pos.unrealizedPnlPct.toFixed(2)}%)</span>
                  </td>
                  <td style={{ color: 'var(--OnBackground-Disabled)' }}>${pos.liquidationPrice.toFixed(0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}
