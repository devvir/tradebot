import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as root from '../src';
import * as testing from '../src/testing';

const PKG = join(__dirname, '..');

interface Manifest {
  exports: Record<string, string | { types: string; default: string }>;
  typesVersions: Record<string, Record<string, string[]>>;
}

const manifest = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8')) as Manifest;

/** The source file a built `dist/` path is compiled from. */
const sourceOf = (distPath: string): string =>
  join(PKG, distPath.replace(/^\.?\/?dist\//, 'src/').replace(/\.d\.ts$|\.js$/, '.ts'));

describe('package surface', () => {
  it('keeps the test helpers out of the root entry', () => {
    for (const name of Object.keys(testing)) expect(root).not.toHaveProperty(name);
  });

  it('serves the test helpers from the testing entry', () => {
    expect(Object.keys(testing).sort()).toEqual(['loadTestingEnv', 'parseEnvFile', 'startRabbitMQ', 'stopRabbitMQ']);
  });

  it.each([
    ['.', 'src/index.ts'],
    ['./testing', 'src/testing/index.ts'],
  ])('maps the %s entry, code and types, to the build of %s', (subpath, source) => {
    const entry = manifest.exports[subpath];
    if (typeof entry === 'string') throw new Error(`${subpath} has no types condition`);

    expect(sourceOf(entry.default)).toBe(join(PKG, source));
    expect(sourceOf(entry.types)).toBe(join(PKG, source));
    expect(existsSync(join(PKG, source))).toBe(true);
  });

  it('maps the testing subpath for type resolution without package exports', () => {
    const [target] = manifest.typesVersions['*'].testing;

    expect(sourceOf(target)).toBe(join(PKG, 'src/testing/index.ts'));
  });
});
