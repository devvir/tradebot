import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import type { Container } from './types';

/** Already a bare CSV or JSON file — nothing to undo. */
export const plain: Container = {
  native: true,
  unpack: async () => { throw new Error('plain files are read natively and are never unpacked'); },

  /** A small file read where it stands; a large one is the engine's to read. */
  members: absolute =>
    (statSync(absolute).size > SMALL_BYTES ? null : [{ name: basename(absolute), data: readFileSync(absolute) }]),
};

/** The largest file read into memory. */
const SMALL_BYTES = 64 * 1024;
