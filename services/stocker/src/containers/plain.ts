import type { Container } from './types';

/** Already a bare CSV or JSON file — nothing to undo. */
export const plain: Container = {
  native: true,
  unpack: async () => { throw new Error('plain files are read natively and are never unpacked'); },
};
