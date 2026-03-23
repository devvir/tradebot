// Pending Review
import { logger } from '@devvir/service-kit';
import type { Config } from './types';

export interface BouncerResponse {
  id:     string;
  type:   'live' | 'testnet' | 'replay';
  apiKey: string;
}

export interface AccountData {
  id:     string;
  type:   'live' | 'testnet' | 'replay';
  apiKey: string;
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

      const raw  = await res.json() as BouncerResponse;
      const data: AccountData = { ...raw };

      cache.set(accountId, data);
      logger.debug({ accountId }, 'Account cached');

      return data;
    },
  };
}
