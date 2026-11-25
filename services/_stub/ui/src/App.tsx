import './styles/app.css';
import { Navigate, Route, Routes } from 'react-router-dom';
import { Header }     from './components/Header';
import { WidgetGrid } from './components/WidgetGrid';
import { DEFAULT_SYMBOL } from './utils/useSymbol';

function MarketView() {
  return (
    <div className="app-shell">
      <Header />
      <div className="app-body">
        <WidgetGrid />
      </div>
    </div>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/"         element={<Navigate to={`/${DEFAULT_SYMBOL}`} replace />} />
      <Route path="/:symbol"  element={<MarketView />} />
    </Routes>
  );
}
