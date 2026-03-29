import { logger } from '@devvir/service-kit';

export const loadRegistryMap = async (registryUrl: string): Promise<Map<string, number>> => {
  const [symbolsRes, currenciesRes] = await Promise.all([
    fetch(`${registryUrl}/symbols`),
    fetch(`${registryUrl}/currencies`),
  ]);

  const symbols    = await symbolsRes.json()    as Array<{ id: number; symbol: string }>;
  const currencies = await currenciesRes.json() as Array<{ id: number; currency: string }>;

  const map = new Map<string, number>();

  for (const { id, symbol } of symbols)      map.set(symbol, id);
  for (const { id, currency } of currencies) map.set(currency, id);

  logger.info({ symbols: symbols.length, currencies: currencies.length }, 'Registry map loaded');

  return map;
};
