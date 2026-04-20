import { marginData } from '../../data/mockData';

export function MarginWidget() {
  const pct = (marginData.usedMargin / marginData.walletBalance) * 100;
  const barColor = pct > 80 ? 'var(--Sell-Primary)' : pct > 50 ? 'var(--OnBackground-Warning)' : 'var(--Buy-Primary)';

  return (
    <section className="widget">
      <div className="widget__header">
        <span className="widget__title">Margin</span>
      </div>
      <div className="widget__body">
        {[
          { label: 'Wallet Balance',     value: `$${marginData.walletBalance.toFixed(2)}`,     cls: '' },
          { label: 'Available Margin',   value: `$${marginData.availableMargin.toFixed(2)}`,   cls: 'margin__value--positive' },
          { label: 'Used Margin',        value: `$${marginData.usedMargin.toFixed(2)}`,        cls: '' },
          { label: 'Initial Margin',     value: `$${marginData.initialMargin.toFixed(2)}`,     cls: '' },
          { label: 'Maintenance Margin', value: `$${marginData.maintenanceMargin.toFixed(2)}`, cls: '' },
        ].map((item) => (
          <div className="margin__item" key={item.label}>
            <span className="margin__label">{item.label}</span>
            <span className={`margin__value ${item.cls}`}>{item.value}</span>
          </div>
        ))}
        <div className="margin__bar-track">
          <div className="margin__bar-fill" style={{ width: `${Math.min(pct, 100)}%`, background: barColor }} />
        </div>
        <div style={{ textAlign: 'right', fontSize: 10, color: 'var(--OnBackground-Disabled)', padding: '2px 10px 6px' }}>
          {pct.toFixed(1)}% used
        </div>
      </div>
    </section>
  );
}
