export interface Config {
  token:    string;   // shared Bearer token required on all authenticated endpoints
  dataPath: string;   // path to accounts.json on the named volume
  httpPort: number;
  [key: string]: unknown;
}

export type AccountType = 'live' | 'testnet' | 'replay';

export interface StoredAccount {
  id:        string;
  type:      AccountType;
  apiKey:    string;
  apiSecret: string;  // never returned to callers
}

export type AccountSummary = Omit<StoredAccount, 'apiSecret'>;
