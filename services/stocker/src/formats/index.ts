import { csv } from './csv';
import { ndjson } from './ndjson';
import { xlsx } from './xlsx';
import type { Format } from './types';

const FORMATS: Record<string, Format> = { csv, ndjson, xlsx };

export const formatFor = (name: string): Format => {
  const format = FORMATS[name];

  if (! format)
    throw new Error(`Unknown format '${name}'. Known: ${Object.keys(FORMATS).join(', ')}`);

  return format;
};

export type { Format } from './types';
