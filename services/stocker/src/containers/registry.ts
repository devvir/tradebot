import { gzip } from './gzip';
import { plain } from './plain';
import { targz } from './targz';
import { zip } from './zip';
import type { Container } from './types';

/**
 * Every container there is, by name. Apart from everything else here so that
 * it can be loaded where nothing of the service is — a worker thread that only
 * extracts.
 */
export const containerFor = (name: string): Container => {
  const container = CONTAINERS[name];

  if (! container)
    throw new Error(`Unknown container '${name}'. Known: ${Object.keys(CONTAINERS).join(', ')}`);

  return container;
};

const CONTAINERS: Record<string, Container> = { zip, gzip, 'tar.gz': targz, plain };
