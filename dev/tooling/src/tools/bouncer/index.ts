import axios from 'axios';
import { info, success, error, section, table, spacer, warn } from '../../shared/ui/logger';
import { discoverBouncerUrl } from '../../shared/connections/bouncer';
import { getEnv } from '../../shared/utils/env';
import { selectFromList, input, password } from '../../shared/ui/prompts';
import type { BouncerAccount } from '../../shared/types/bouncer';

interface BouncerOptions {
  all?: boolean;
  account?: string;
}

export async function run(options: BouncerOptions = {}): Promise<void> {
  section('Bouncer Accounts Tool');
  spacer();

  const bouncerUrl = await discoverBouncerUrl();

  if (! bouncerUrl) {
    throw new Error('BOUNCER_URL not configured and bouncer service not discovered');
  }

  info(`Fetching accounts from ${bouncerUrl}...`);

  try {
    const token   = getEnv('BOUNCER_TOKEN');
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    const response = await axios.get(`${bouncerUrl}/accounts`, { timeout: 5000, headers });
    const accounts: BouncerAccount[] = Array.isArray(response.data) ? response.data : [];

    if (accounts.length === 0) {
      warn('No accounts found');
      return;
    }

    section(`Accounts (${accounts.length})`);
    spacer();

    if (options.all) {
      accounts.forEach((acc, idx) => {
        console.log(`${idx + 1}. ${acc.id}`);
        console.log(`   Type:   ${acc.type}`);
        console.log(`   ApiKey: ${acc.apiKey.substring(0, 8)}...`);
        spacer();
      });
    } else {
      const tableData = accounts.map((acc, idx) => ({
        '#':      String(idx + 1),
        ID:       acc.id,
        Type:     acc.type,
        ApiKey:   acc.apiKey.substring(0, 8) + '...',
      }));

      table(tableData, ['#', 'ID', 'Type', 'ApiKey']);
    }

    if (options.account) {
      section(`Details: ${options.account}`);
      const account = accounts.find(acc => acc.id === options.account);

      if (account) {
        console.log(JSON.stringify(account, null, 2));
      } else {
        warn(`Account "${options.account}" not found`);
      }
    }

    success(`Total accounts: ${accounts.length}`);
  } catch (err) {
    error(`Failed to fetch accounts: ${(err as Error).message}`);
    throw err;
  }
}

export async function add(accountId: string): Promise<void> {
  section('Add Bouncer Account');
  spacer();

  const bouncerUrl = await discoverBouncerUrl();

  if (! bouncerUrl) {
    throw new Error('BOUNCER_URL not configured and bouncer service not discovered');
  }

  const type = await selectFromList(
    [
      { name: '(l)ive',    value: 'live'    as const },
      { name: '(t)estnet', value: 'testnet' as const },
      { name: '(r)eplay',  value: 'replay'  as const },
    ],
    'Server',
  );

  if (! type) throw new Error('No server type selected');

  const apiKey    = await input('ApiKey');
  const apiSecret = await password('ApiSecret');

  if (! apiKey)    throw new Error('ApiKey is required');
  if (! apiSecret) throw new Error('ApiSecret is required');

  const token   = getEnv('BOUNCER_TOKEN');
  const headers = {
    'Content-Type':  'application/json',
    ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
  };

  try {
    const response  = await axios.post(
      `${bouncerUrl}/accounts`,
      { id: accountId, type, apiKey, apiSecret },
      { timeout: 5000, headers },
    );
    const account = response.data as BouncerAccount;
    success(`Account '${account.id}' registered (${account.type})`);
  } catch (err) {
    if (axios.isAxiosError(err) && err.response?.status === 409) {
      throw new Error(`Account '${accountId}' already exists`);
    }
    throw err;
  }
}
