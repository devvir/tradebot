import type { AccountType } from '@tradebot/utils';

export interface Config {
  bouncerUrl:   string;
  bouncerToken: string;
  [key: string]: unknown;
}

export interface AccountSummary {
  id:     string;
  type:   AccountType;
  apiKey: string;
}

export interface SignRestResult {
  apiKey:    string;
  signature: string;
  expires:   number;
}

/** Parsed `x-testnet` header — `explicit` flags whether the caller sent it at all. */
export interface TestnetHint {
  explicit: boolean;
  testnet:  boolean;
}
