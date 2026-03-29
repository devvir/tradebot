export interface Config {
  vaultUrl: string;
  startDate: string | null;
  [key: string]: unknown;
}

export type Table = 'trade' | 'quote';
