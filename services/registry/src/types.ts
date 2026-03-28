export interface Config {
  database: string;
  httpPort: number;
  [key: string]: unknown;
}

export interface Entry {
  _id: number;
  value: string;
}

export type Collection = 'symbols' | 'currencies';
