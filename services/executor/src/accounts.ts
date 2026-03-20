import { logger } from '@devvir/service-kit';
import type { Config } from './types';

export interface AccountData {
  id:      string;
  type:    'live' | 'testnet' | 'replay';
  wsUrl:   string;
  restUrl: string;
  apiKey:  string;
}

export interface AccountRegistry {
  get: (accountId: string) => Promise<AccountData>;
}

export function createAccountRegistry(config: Config): AccountRegistry {
  const cache = new Map<string, AccountData>();

  return {
    async get(accountId) {
      const cached = cache.get(accountId);

      if (cached) return cached;

      const res = await fetch(`${config.bouncerUrl}/accounts/${accountId}`, {
        headers: { 'Authorization': `Bearer ${config.bouncerToken}` },
      });

      if (! res.ok) {
        throw new Error(`Bouncer returned ${res.status} for account '${accountId}'`);
      }

      const data = await res.json() as AccountData;

      cache.set(accountId, data);
      logger.debug({ accountId }, 'Account cached');

      return data;
    },
  };
}
