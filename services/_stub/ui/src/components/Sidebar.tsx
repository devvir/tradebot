import { useState } from 'react';

type OrderType = 'Limit' | 'Market' | 'Stop Market';

export function Sidebar() {
  const [activeTab, setActiveTab] = useState<OrderType>('Limit');
  const [size, setSize]           = useState('200');
  const [price, setPrice]         = useState('68940.0');
  const [leverage, setLeverage]   = useState(10);

  const btcValue = (parseFloat(size) / 68940).toFixed(4);

  return (
    <div className="app-sidebar">
      <div className="sidebar">

        {/* Balance */}
        <div className="sidebar__balance">
          <span>Avail: <strong>0.00 USD</strong></span>
          <svg width="14" height="14" viewBox="0 0 32 32" fill="var(--OnBackground-Disabled)">
            <path d="M19 13H25V15H19zM13 21L11 21 11 19 9 19 9 21 7 21 7 23 9 23 9 25 11 25 11 23 13 23 13 21zM7 9H13V11H7zM19 17H25V19H19z" />
            <path d="M27,3H5A2,2,0,0,0,3,5V27a2,2,0,0,0,2,2H27a2,2,0,0,0,2-2V5A2,2,0,0,0,27,3ZM15,5V15H5V5ZM5,17H15V27H5ZM17,27V5H27V27Z" />
          </svg>
        </div>

        {/* Controls */}
        <div className="sidebar__controls">
          <button className="bmxc-button-root bmxc-button-outline bmxc-button-small">
            Single-Asset
            <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 11L3 6 3.7 5.3 8 9.6 12.3 5.3 13 6z" />
            </svg>
          </button>
          <button className="bmxc-button-root bmxc-button-outline bmxc-button-small">
            100x
            <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 11L3 6 3.7 5.3 8 9.6 12.3 5.3 13 6z" />
            </svg>
          </button>
        </div>

        {/* Order type tabs */}
        <ul className="sidebar__tabs">
          {(['Limit', 'Market', 'Stop Market'] as OrderType[]).map((tab) => (
            <li
              key={tab}
              className={`sidebar__tab${activeTab === tab ? ' sidebar__tab--active' : ''}`}
              onClick={() => setActiveTab(tab)}
            >
              {tab}
            </li>
          ))}
        </ul>

        {/* Size */}
        <div className="sidebar__field">
          <label className="sidebar__label">Size</label>
          <div className="sidebar__input-row">
            <input
              className="sidebar__input"
              type="number"
              value={size}
              min="0"
              max="100000000"
              step="100"
              onChange={(e) => setSize(e.target.value)}
            />
            <span className="sidebar__addon">USD</span>
          </div>
          <span className="sidebar__converted">≈ {btcValue} BTC</span>
        </div>

        {/* Price (hidden for Market) */}
        {activeTab !== 'Market' && (
          <div className="sidebar__field">
            <label className="sidebar__label">{activeTab === 'Stop Market' ? 'Stop Price' : 'Price'}</label>
            <div className="sidebar__input-row">
              <input
                className="sidebar__input"
                type="number"
                value={price}
                min="0"
                step="0.5"
                onChange={(e) => setPrice(e.target.value)}
              />
              <span className="sidebar__addon">USD</span>
            </div>
          </div>
        )}

        {/* Leverage slider */}
        <div className="sidebar__field">
          <label className="sidebar__label">Leverage — {leverage}x</label>
          <input
            type="range"
            min="1"
            max="100"
            value={leverage}
            onChange={(e) => setLeverage(Number(e.target.value))}
          />
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, color: 'var(--OnBackground-Disabled)', marginTop: 2 }}>
            <span>1x</span><span>25x</span><span>50x</span><span>75x</span><span>100x</span>
          </div>
        </div>

        {/* Actions */}
        <div className="sidebar__actions">
          <a href="https://www.bitmex.com/app/login" className="bmxc-button-root bmxc-button-outline bmxc-button-full" style={{ flex: 1, justifyContent: 'center' }}>
            Login
          </a>
          <a href="https://www.bitmex.com/app/register" className="bmxc-button-root bmxc-button-primary bmxc-button-full" style={{ flex: 1, justifyContent: 'center' }}>
            Sign Up
          </a>
        </div>

      </div>
    </div>
  );
}
