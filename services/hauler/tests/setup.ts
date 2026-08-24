/**
 * Config is loaded when a module is imported, and two values have no defaults —
 * deliberately, since a hauler that starts without them downloads nothing. Tests
 * that import anything touching config need them present.
 */
process.env['CATALOG_URL']   ??= 'http://catalog.invalid';
process.env['CATALOG_TOKEN'] ??= 'test-token';
