import { trucker } from './trucker';
import type { Source } from './types';

/**
 * Origins stocker reads. The REST and websocket collectors and vault's BitMEX
 * history join this list as they arrive; nothing downstream changes when they
 * do, because everything past discovery sees only `RawFile`.
 */
const SOURCES: Source[] = [trucker];

export const sources = (): Source[] => SOURCES;

export const sourceFor = (name: string): Source => {
  const source = SOURCES.find(s => s.name === name);

  if (! source)
    throw new Error(`Unknown source '${name}'. Known: ${SOURCES.map(s => s.name).join(', ')}`);

  return source;
};

export type { Source } from './types';
