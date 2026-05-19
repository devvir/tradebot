export interface Config {
  database:         string;
  ignoreDuplicates: boolean;
  [key: string]:    unknown;
}
