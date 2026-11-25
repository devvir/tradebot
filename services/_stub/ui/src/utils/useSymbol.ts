import { useParams } from 'react-router-dom';

/** Contract shown when the URL names none. */
export const DEFAULT_SYMBOL = 'XBTUSD';

/** Contract symbol from the `/:symbol` route, or DEFAULT_SYMBOL outside it. */
export function useSymbol(): string {
  return useParams<{ symbol: string }>().symbol ?? DEFAULT_SYMBOL;
}
