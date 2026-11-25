/**
 * Config is loaded when a module is imported; tests point it at a catalog that
 * resolves nowhere, so nothing reaches a real one.
 */
process.env['CATALOG_API']   ??= 'http://catalog.invalid';
process.env['CATALOG_TOKEN'] ??= 'test-token';
