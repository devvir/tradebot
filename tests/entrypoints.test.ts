/**
 * Every way a service is started must name the file the compiler emits for
 * `src/index.ts`: the package's `main`, its `start` script, the prod image's
 * CMD (run from the service directory) and the dev image's entrypoint (run from
 * the workspace root).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';

const root = join(__dirname, '..');
const servicesDir = join(root, 'services');

const readJson = (path: string): Record<string, any> => JSON.parse(readFileSync(path, 'utf8'));

const services = readdirSync(servicesDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && !entry.name.startsWith('_'))
  .map((entry) => entry.name)
  .filter((name) => existsSync(join(servicesDir, name, 'package.json')))
  .filter((name) => existsSync(join(servicesDir, name, 'src', 'index.ts')));

/**
 * Where tsc writes `src/index.ts`, relative to the service directory. With
 * `composite` and no `rootDir`, the root is the directory of the tsconfig.
 */
const emittedEntry = (service: string): string => {
  const { compilerOptions = {} } = readJson(join(servicesDir, service, 'tsconfig.json'));
  const outDir = posix.normalize(compilerOptions.outDir ?? '.');
  const rootDir = posix.normalize(compilerOptions.rootDir ?? '.');
  return posix.join(outDir, posix.relative(rootDir, 'src/index.ts')).replace(/\.ts$/, '.js');
};

describe('service entrypoints', () => {
  it('finds the node services', () => {
    expect(services.length).toBeGreaterThan(0);
  });

  describe.each(services)('%s', (service) => {
    const pkg = readJson(join(servicesDir, service, 'package.json'));
    const entry = emittedEntry(service);

    it('declares the emitted entry as main', () => {
      expect(posix.normalize(pkg.main)).toBe(entry);
    });

    it('starts the emitted entry', () => {
      expect(pkg.scripts?.start).toBe(`node ${entry}`);
    });

    it('is started by the prod image at the emitted entry', () => {
      const dockerfile = readFileSync(join(root, 'docker', 'prod.node.Dockerfile'), 'utf8');
      const cmd = dockerfile.match(/^CMD .*exec node [^"]*?(\S+\.js)"\]$/m);
      expect(cmd?.[1]).toBe(entry);
    });

    it('is started by the dev image at the emitted entry', () => {
      const script = readFileSync(join(root, 'docker', 'node', 'entrypoint.sh'), 'utf8');
      const exec = script.match(/^exec node .*"services\/\$\{SERVICE_NAME\}\/(\S+\.js)"$/m);
      expect(exec?.[1]).toBe(entry);
    });
  });
});
