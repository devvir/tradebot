import { describe, it, expect, afterAll } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, existsSync } from 'node:fs';
import { saveAccount, listAccounts, getAccount, deleteAccount } from '../src/store';
import type { StoredAccount } from '../src/types';

const DATA_PATH = join(tmpdir(), `bouncer-store-test-${process.pid}.json`);

const TEST_ACCOUNT: StoredAccount = {
  id:        'acc-1',
  type:      'testnet',
  wsUrl:     'wss://testnet.bitmex.com/realtime',
  restUrl:   'https://testnet.bitmex.com/api/v1',
  apiKey:    'key-abc',
  apiSecret: 'secret-xyz',
};

afterAll(() => {
  if (existsSync(DATA_PATH)) {
    rmSync(DATA_PATH);
  }
});

describe('saveAccount', () => {
  it('creates account and returns "created"', async () => {
    const result = await saveAccount(DATA_PATH, TEST_ACCOUNT);

    expect(result).toBe('created');
  });

  it('returns "exists" for duplicate id', async () => {
    const result = await saveAccount(DATA_PATH, TEST_ACCOUNT);

    expect(result).toBe('exists');
  });
});

describe('listAccounts', () => {
  it('returns array of summaries without apiSecret', () => {
    const accounts = listAccounts(DATA_PATH);

    expect(accounts).toHaveLength(1);
    expect(accounts[0]!.id).toBe('acc-1');
    expect(accounts[0]).not.toHaveProperty('apiSecret');
  });
});

describe('getAccount', () => {
  it('returns full account including apiSecret', () => {
    const account = getAccount(DATA_PATH, 'acc-1');

    expect(account).not.toBeNull();
    expect(account!.apiSecret).toBe('secret-xyz');
    expect(account!.apiKey).toBe('key-abc');
  });

  it('returns null for unknown id', () => {
    const account = getAccount(DATA_PATH, 'does-not-exist');

    expect(account).toBeNull();
  });
});

describe('deleteAccount', () => {
  it('removes the account', async () => {
    await deleteAccount(DATA_PATH, 'acc-1');

    expect(getAccount(DATA_PATH, 'acc-1')).toBeNull();
  });

  it('is idempotent — no error for unknown id', async () => {
    await expect(deleteAccount(DATA_PATH, 'acc-1')).resolves.toBeUndefined();
  });

  it('getAccount returns null after delete', () => {
    expect(getAccount(DATA_PATH, 'acc-1')).toBeNull();
  });
});
