import type { components } from '@devvir/bitmex-api/types';
import { logger } from '@devvir/service-kit';

type Instrument = components['schemas']['Instrument'];
type Symbols = { indices: string[]; inactive: Set<string> };

const PAGE_SIZE = 1000;

export const fetchSymbols = async (baseUrl: string): Promise<Symbols> => {
  const all: Instrument[] = [];
  let start = 0;

  while (true) {
    const url = `${baseUrl}/instrument?count=${PAGE_SIZE}&start=${start}&columns=symbol,state&reverse=false`;
    const res = await fetch(url);

    if (! res.ok)
      throw new Error(`Failed to fetch instrument list: HTTP ${res.status}`);

    const page = (await res.json()) as Instrument[];

    all.push(...page);

    if (page.length < PAGE_SIZE) break;

    start += PAGE_SIZE;
  }

  const indices  = all.filter(i =>   i.symbol.startsWith('.')).map(i => i.symbol);
  const inactive = new Set(all.filter(i => i.state !== 'Open').map(i => i.symbol));

  logger.info({ indices: indices.length, inactive: inactive.size }, 'Symbol list loaded');

  return { indices, inactive };
};
