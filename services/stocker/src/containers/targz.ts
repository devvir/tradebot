import { mkdir } from 'node:fs/promises';
import { isAbsolute, join, normalize, relative, sep } from 'node:path';
import type { Container } from './types';

/**
 * Order-book archives ship this way, holding one `.data` file of JSON lines.
 *
 * **Members keep the folders they were archived under**, inside a directory of
 * this archive's own, and each is returned at the path it was written to. Only
 * files are returned — no folders or links — and only those that land inside
 * that directory.
 */
export const targz: Container = {
  native: false,

  unpack: async (absolute, into, tag) => {
    const { list, x } = await import('tar');
    const names: string[] = [];

    // A directory of its own: `tar` writes members under their own names.
    const own = join(into, tag);

    await mkdir(own, { recursive: true });

    await list({
      file:        absolute,
      onReadEntry: (entry) => { if (FILES.has(entry.type)) names.push(entry.path); },
    });

    await x({ file: absolute, cwd: own });

    return names.map(name => join(own, normalize(name))).filter(path => inside(own, path));
  },
};

/** The entry types that are a file's contents. */
const FILES = new Set(['File', 'OldFile']);

/** Whether `path` lies within `dir`. */
const inside = (dir: string, path: string): boolean => {
  const from = relative(dir, path);

  return from !== '' && from !== '..' && ! from.startsWith(`..${sep}`) && ! isAbsolute(from);
};
