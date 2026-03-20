import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { StoredAccount, AccountSummary } from './types';

type AccountMap = Record<string, StoredAccount>;

let cache: AccountMap | null = null;

function getCache(dataPath: string): AccountMap {
  if (cache)
    return cache;

  cache = existsSync(dataPath)
    ? JSON.parse(readFileSync(dataPath, 'utf-8')) as AccountMap
    : {};

  return cache;
}

async function persist(dataPath: string, accounts: AccountMap): Promise<void> {
  mkdirSync(dirname(dataPath), { recursive: true });

  await writeFile(dataPath, JSON.stringify(accounts, null, 2), 'utf-8');
}

export function listAccounts(dataPath: string): AccountSummary[] {
  return Object.values(getCache(dataPath)).map(
    ({ apiSecret: _secret, ...summary }) => summary
  );
}

export function getAccount(dataPath: string, id: string): StoredAccount | null {
  return getCache(dataPath)[id] ?? null;
}

export async function deleteAccount(dataPath: string, id: string): Promise<void> {
  const accounts = getCache(dataPath);

  if (! accounts[id]) return;

  delete accounts[id];

  await persist(dataPath, accounts);
}

export async function saveAccount(dataPath: string, account: StoredAccount): Promise<'created' | 'exists'> {
  const accounts = getCache(dataPath);

  if (accounts[account.id])
    return 'exists';

  accounts[account.id] = account;

  await persist(dataPath, accounts);

  return 'created';
}
