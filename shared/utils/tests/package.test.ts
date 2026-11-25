import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ViteUserConfig } from 'vitest/config';
import * as root from '../src';
import * as env from '../src/env';
import * as retry from '../src/retry';
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
    expect(Object.keys(testing).sort()).toEqual(['loadTestingEnv', 'startRabbitMQ', 'stopRabbitMQ']);
  });

  it('serves the env and retry helpers from the root entry and from entries of their own', () => {
    for (const [name, value] of Object.entries({ ...env, ...retry })) expect(root).toHaveProperty(name, value);
  });

  it.each([
    ['.', 'src/index.ts'],
    ['./env', 'src/env.ts'],
    ['./retry', 'src/retry.ts'],
    ['./testing', 'src/testing/index.ts'],
  ])('maps the %s entry, code and types, to the build of %s', (subpath, source) => {
    const entry = manifest.exports[subpath];
    if (typeof entry === 'string') throw new Error(`${subpath} has no types condition`);

    expect(sourceOf(entry.default)).toBe(join(PKG, source));
    expect(sourceOf(entry.types)).toBe(join(PKG, source));
    expect(existsSync(join(PKG, source))).toBe(true);
  });

  it('resolves every entry to its source in the suites, so none runs against a stale or missing build', async () => {
    // Loaded by path: the repository's config sits outside this package's sources.
    const configPath = join(PKG, '..', '..', 'vitest.config.ts');
    const { default: config } = (await import(configPath)) as { default: ViteUserConfig };
    const aliases = config.resolve?.alias;
    if (! Array.isArray(aliases)) throw new Error('the root vitest config has no alias list');

    const subpaths = Object.keys(manifest.exports).filter(subpath => subpath !== './package.json');

    expect(subpaths.length).toBeGreaterThan(0);

    for (const subpath of subpaths) {
      const entry = manifest.exports[subpath];
      if (typeof entry === 'string') throw new Error(`${subpath} has no types condition`);

      const specifier = '@tradebot/utils' + subpath.slice(1);
      const matches = aliases.filter(({ find }) =>
        typeof find === 'string' ? find === specifier : find.test(specifier));

      expect(matches, specifier).toHaveLength(1);
      expect(matches[0].replacement, specifier).toBe(sourceOf(entry.default));
    }
  });

  it.each([
    ['env', 'src/env.ts'],
    ['retry', 'src/retry.ts'],
    ['testing', 'src/testing/index.ts'],
  ])('maps the %s subpath for type resolution without package exports', (subpath, source) => {
    const [target] = manifest.typesVersions['*'][subpath];

    expect(sourceOf(target)).toBe(join(PKG, source));
  });
});
