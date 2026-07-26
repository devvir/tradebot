export function ContractBar() {
  return (
    <section className="ContractBar__index__root__XRl6r">

      {/* Contract picker */}
      <div className="ContractBar__ContractPicker__root__gMTMf">
        <div className="ContractBar__ContractDropdown__dropdownButton__WOeiy">
          <div className="ContractBar__ContractTicker__wrappingLayout__hmiuQ">
            <div className="ContractBar__ContractTicker__contentWrapper__vg2UE">
              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <span className="ContractBar__ContractTicker__ticker__IcxKH">BTCUSD</span>
                <span className="ContractBar__ContractTicker__contractType__YbJan">Perp</span>
              </div>
              <div className="ContractBar__ContractTicker__pills__RAfD7">
                <span className="bmxc-pill-root bmxc-pill-xbt">BTC</span>
                <span className="bmxc-pill-root">100x</span>
              </div>
            </div>
          </div>
          <svg width="12" height="12" viewBox="0 0 32 32" fill="currentColor">
            <path d="M24 12L16 22 8 12z" />
          </svg>
        </div>
      </div>

      <div className="ContractBar__VerticalSeparator__root__xGdzH" />

      {/* Stats */}
      <div className="ContractBar__ContractDetails__root__UQ6GV">

        <div className="ContractBar__ContractDetails__priceStack__F940O">
          <span className="molecules__PriceTicker__tickerText__MDMDZ molecules__PriceTicker__positive__CEBBd">
            68,940.2
          </span>
          <span className="ContractBar__ContractDetails__lastPercentage__L__kz ContractBar__ContractDetails__positive__uJ5YS">
            +4.77%
          </span>
        </div>

        <div className="ContractBar__ContractDetails__contractBar__C5MB3">
          {[
            { label: 'Mark Price',   value: '68,990.31' },
            { label: 'Index Price',  value: '68,995.49' },
            { label: '24H Volume',   value: '189,188,600 USD' },
            { label: 'Funding Rate', value: '-0.0030%' },
            { label: 'Open Interest',value: '1.02B USD' },
          ].map((item) => (
            <div className="ContractBar__ContractDetails__rowItem__sIpvf" key={item.label}>
              <label className="ContractBar__ContractDetails__rowLabel__z070R">{item.label}</label>
              <div className="ContractBar__ContractDetails__rowValue__GIQsP">{item.value}</div>
            </div>
          ))}
        </div>

      </div>
    </section>
  );
}
