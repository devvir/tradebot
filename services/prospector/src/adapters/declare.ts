import type { Adapter, Scanner } from '../types';

/**
 * Declare a venue's adapter: everything about it **except where it is**.
 *
 * `base` and `root` are constants of the application kept in the `venue` table
 * so everything else can join against them — see the `venues` migration. They
 * are read from there at startup by `addressVenues`, which is why no adapter
 * names an address: one unit of information, one place.
 *
 * **Here rather than beside the registry**, small as it is, because the registry
 * imports every adapter and every adapter would import this: with them in one
 * module, an adapter loaded first finds the registry mid-evaluation and builds
 * its list out of exports that do not exist yet.
 */
export const declare = <S extends Scanner<any>>(
  spec: Omit<Adapter<S>, 'base' | 'root'>,
): Adapter<S> => ({ ...spec, base: '', root: '' } as Adapter<S>);
