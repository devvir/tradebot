/**
 * The addresses a lens can be stored under. They follow the catalog's own test,
 * copied here since this page does not import the catalog's packages.
 */

/**
 * Addresses no lens can take: the catalog answers each of these paths under
 * `/lenses` itself, so a lens there could not be reached.
 */
export const RESERVED_ADDRESSES: readonly string[] = ['options', 'size', 'check', 'resolve'];

/** Whether an address is one of the catalog's own paths under `/lenses`, which no lens can take. */
export const addressIsReserved = (slug: string): boolean => RESERVED_ADDRESSES.includes(slug);

/**
 * Whether an address is one the catalog stores a lens under: lower case, digits
 * and hyphens, 2 to 64 characters, not starting with a hyphen, and not
 * reserved (`addressIsReserved`).
 */
export const addressIsSound = (slug: string): boolean =>
  /^[a-z0-9][a-z0-9-]{1,63}$/.test(slug) && ! addressIsReserved(slug);
