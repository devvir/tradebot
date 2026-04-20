import './styles/bitmex.css';
import { Navigate, Route, Routes } from 'react-router-dom';
import { DataProvider } from './data/DataProvider';
import { Header }       from './components/Header';
import { ContractBar }  from './components/ContractBar';
import { Sidebar }      from './components/Sidebar';
import { WidgetGrid }   from './components/WidgetGrid';

function BottomBar() {
  return (
    <footer className="bottom-bar">
      <div className="bottom-bar__item">
        <span className="bottom-bar__dot" />
        <span>Online</span>
      </div>
      <div className="bottom-bar__item">
        BTCUSD <span className="bottom-bar__price">68,940.2</span>
      </div>
      <div className="bottom-bar__item">
        ETHUSD <span className="bottom-bar__price">3,120.5</span>
      </div>
      <div className="bottom-bar__item">
        Funding <span className="bottom-bar__price">-0.0030%</span>
      </div>
    </footer>
  );
}

function MarketView() {
  return (
    <DataProvider>
      <div className="app-shell">
        <Header />
        <ContractBar />
        <div className="app-body">
          <Sidebar />
          <WidgetGrid />
        </div>
        <BottomBar />
      </div>
    </DataProvider>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/"         element={<Navigate to="/XBTUSD" replace />} />
      <Route path="/:symbol"  element={<MarketView />} />
    </Routes>
  );
}
