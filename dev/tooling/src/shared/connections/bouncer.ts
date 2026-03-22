import axios from 'axios';
import { getEnv } from '../utils/env';
import { discoverService } from '../utils/service-discovery';
import { warn } from '../ui/logger';
import type { BouncerAccount } from '../types/bouncer';

export async function discoverBouncerUrl(): Promise<string | null> {
  let url = getEnv('BOUNCER_URL');

  const discovered = await discoverService(
    'bouncer',
    (host, port) => `http://${host}:${port}`,
    3010,
  );

  if (discovered) url = discovered.url;

  return url ?? null;
}

export async function fetchBouncerAccounts(): Promise<BouncerAccount[]> {
  const url = await discoverBouncerUrl();

  if (! url) {
    warn('Bouncer not configured or discovered');
    return [];
  }

  try {
    const token = getEnv('BOUNCER_TOKEN');
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    const response = await axios.get(`${url}/accounts`, { timeout: 5000, headers });
    return Array.isArray(response.data) ? response.data : [];
  } catch (err) {
    warn('Could not fetch accounts from Bouncer: ' + (err as Error).message);
    return [];
  }
}

export async function signWsAccount(
  accountId: string,
  expires: number,
): Promise<{ apiKey: string; signature: string; expires: number } | null> {
  const url = await discoverBouncerUrl();

  if (! url) return null;

  try {
    const token = getEnv('BOUNCER_TOKEN');
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    const response = await axios.post(`${url}/sign/ws`, { accountId, expires }, { timeout: 5000, headers });
    return response.data;
  } catch (err) {
    warn('Could not sign WS auth with Bouncer: ' + (err as Error).message);
    return null;
  }
}
