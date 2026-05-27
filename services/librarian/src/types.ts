export interface Config {
  database:         string;
  ignoreDuplicates: boolean;
  [key: string]:    unknown;
}

/** Callbacks fired by every successful op — feed the throughput metrics. */
export type InsertCounter = (n: number) => void;
export type ReadCounter   = (n: number) => void;
