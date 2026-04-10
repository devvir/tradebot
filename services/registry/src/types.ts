export interface Config {
  database: string;
  [key: string]: unknown;
}

export interface Entry {
  _id: number;
  value: string;
}

export type Collection = 'symbols' | 'currencies';
