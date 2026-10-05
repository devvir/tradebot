import { mkdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { Container } from './types';

/** Order-book archives ship this way, holding one `.data` file of JSON lines. */
export const targz: Container = {
  native: false,

  unpack: async (absolute, into, tag) => {
    const { list, x } = await import('tar');
    const names: string[] = [];

    // A directory of its own: `tar` writes members under their own names.
    const own = join(into, tag);

    await mkdir(own, { recursive: true });

    await list({ file: absolute, onentry: (e: { path: string }) => { names.push(e.path); } });
    await x({ file: absolute, cwd: own });

    return names.filter(n => ! n.endsWith('/')).map(n => join(own, basename(n)));
  },
};
