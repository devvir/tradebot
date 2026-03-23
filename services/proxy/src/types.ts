import type { AccountType } from '@tradebot/utils';

export interface Config {
  bouncerUrl:   string;
  bouncerToken: string;
  httpPort:     number;
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
