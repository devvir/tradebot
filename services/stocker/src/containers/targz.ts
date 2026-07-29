import { basename, join } from 'node:path';
import type { Container } from './types';

/** Order-book archives ship this way, holding one `.data` file of JSON lines. */
export const targz: Container = {
  native: false,

  unpack: async (absolute, into) => {
    const { list, x } = await import('tar');
    const names: string[] = [];

    await list({ file: absolute, onentry: (e: { path: string }) => { names.push(e.path); } });
    await x({ file: absolute, cwd: into });

    return names.filter(n => ! n.endsWith('/')).map(n => join(into, basename(n)));
  },
};
