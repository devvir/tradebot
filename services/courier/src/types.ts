export type Table = 'trade' | 'quote';

export interface Config {
  vaultUrl: string;
  startDate: string | null;
  tables: Table[];
  [key: string]: unknown;
}
