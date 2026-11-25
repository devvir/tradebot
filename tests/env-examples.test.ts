/**
 * The .env.example files are copied verbatim into .env and read by docker
 * compose, whose dotenv parser keeps a `# comment` as the value when it follows
 * an empty one (`VAR=   # note` sets VAR to "# note"). Every comment therefore
 * sits on its own line, and the values the examples leave to the root .env
 * resolve there.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = join(__dirname, '..');

/** Directories that are not this repository's own sources: dependencies, build output, submodules. */
const skipped = (dir: string, name: string): boolean =>
  name === 'node_modules' || name === 'dist' || name.startsWith('.') ||
  readdirSync(join(dir, name)).includes('.git');

const findExamples = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) return skipped(dir, entry.name) ? [] : findExamples(join(dir, entry.name));

    return entry.name === '.env.example' ? [join(dir, entry.name)] : [];
  });

const examples = findExamples(root).map((path) => relative(root, path));

const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

const assignments = (file: string): Array<[string, string]> =>
  readFileSync(join(root, file), 'utf8')
    .split('\n')
    .map((line) => line.match(assignment))
    .filter((match): match is RegExpMatchArray => match !== null)
    .map((match) => [match[1], match[2]]);

/** Merge env files in order, later ones winning, then resolve `${VAR}` against the result. */
const resolve = (files: string[], shell: Record<string, string>): Record<string, string> => {
  const merged: Record<string, string> = {};

  for (const file of files) for (const [key, value] of assignments(file)) merged[key] = value;

  Object.assign(merged, shell);

  for (const key of Object.keys(merged)) {
    merged[key] = merged[key].replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name) => merged[name] ?? '');
  }

  return merged;
};

describe('.env.example files', () => {
  it('finds the root and module examples', () => {
    expect(examples).toEqual(expect.arrayContaining([
      '.env.example',
      'modules/collect/archives/.env.example',
      'modules/store/warehouse/.env.example',
    ]));
  });

  describe.each(examples)('%s', (file) => {
    it('keeps every comment on its own line', () => {
      const inline = readFileSync(join(root, file), 'utf8')
        .split('\n')
        .filter((line) => /^[A-Za-z_][A-Za-z0-9_]*=(\s*#|.*\s#)/.test(line));

      expect(inline).toEqual([]);
    });

    it('does not set COMPOSE_PROJECT_NAME', () => {
      expect(assignments(file).map(([key]) => key)).not.toContain('COMPOSE_PROJECT_NAME');
    });
  });

  describe('the data root', () => {
    const dataDir = '/srv/tradebot';
    const env = resolve(['.env.example', 'modules/collect/archives/.env.example'], { DATA_DIR: dataDir });

    it('leaves DATA_DIR for the operator to set', () => {
      expect(resolve(['.env.example'], {}).DATA_DIR).toBe('');
    });

    it('puts the catalog, archives and vault under DATA_DIR', () => {
      expect(env.CATALOG_DIR).toBe(`${dataDir}/catalog`);
      expect(env.DATA_ARCHIVES_DIR).toBe(`${dataDir}/archives`);
      expect(env.DATA_VAULT_DIR).toBe(`${dataDir}/vault`);
    });
  });
});
