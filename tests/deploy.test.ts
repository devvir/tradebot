/**
 * What the prod image deploys: `pnpm deploy` copies each workspace package as
 * it would be published, which leaves out whatever an ignore file of the
 * package names. The submodules' .gitignore files name dist/, so the image is
 * complete only while no .gitignore enters the build context and no workspace
 * package has an .npmignore, and the builder checks the deployed tree against
 * the workspace before the image is made.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';

const root = join(__dirname, '..');
const script = join(root, 'docker', 'node', 'check-deploy.mjs');

/** Every workspace package's directory, by the globs of pnpm-workspace.yaml. */
const workspacePackages = (): string[] =>
  [...(readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8').match(/^packages:\n((?:\s+-.*\n)+)/m)?.[1] ?? '')
    .matchAll(/^\s+-\s+(\S+)$/gm)]
    .map((match) => match[1])
    .flatMap((glob) => glob.endsWith('/*')
      ? readdirSync(join(root, glob.slice(0, -2)), { withFileTypes: true })
        .filter((entry) => entry.isDirectory()).map((entry) => join(glob.slice(0, -2), entry.name))
      : [glob])
    .filter((dir) => existsSync(join(root, dir, 'package.json')));

/** Every file named `name` under `dir`, outside node_modules, build output and version control. */
const findNamed = (dir: string, name: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) {
      return ['node_modules', 'dist', '.git', 'coverage'].includes(entry.name) ? [] : findNamed(join(dir, entry.name), name);
    }

    return entry.name === name ? [join(dir, entry.name)] : [];
  });

describe('the build context', () => {
  const ignored = readFileSync(join(root, '.dockerignore'), 'utf8').split('\n').map((line) => line.trim());

  it('leaves out every .gitignore, and lets none back in', () => {
    expect(ignored).toContain('**/.gitignore');
    expect(ignored.filter((line) => line.startsWith('!') && line.includes('.gitignore'))).toEqual([]);
  });

  it('finds the workspace packages', () => {
    expect(workspacePackages()).toEqual(expect.arrayContaining(['packages/service-kit', 'shared/utils', 'services/router']));
  });

  it.each(workspacePackages())('has no .npmignore in %s', (dir) => {
    expect(findNamed(join(root, dir), '.npmignore').map((file) => relative(root, file))).toEqual([]);
  });

  it.each(workspacePackages())('publishes the built directory of %s, if it lists its files', (dir) => {
    const { main = 'dist/index.js', files } = JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8'));
    const built = main.replace(/^\.\//, '').split('/')[0];

    if (files !== undefined) expect(files.map((file: string) => file.replace(/^\.\//, '').replace(/\/.*$/, ''))).toContain(built);
  });
});

describe('the prod image\'s builder', () => {
  it('checks the deployed tree right after the deploy', () => {
    const lines = readFileSync(join(root, 'docker', 'prod.node.Dockerfile'), 'utf8').split('\n').filter((line) => line.startsWith('RUN '));
    const deploy = lines.findIndex((line) => / deploy --prod \/deploy$/.test(line));

    expect(deploy).toBeGreaterThanOrEqual(0);
    expect(lines[deploy + 1]).toBe('RUN node docker/node/check-deploy.mjs /app /deploy');
  });
});

describe('the deploy check', () => {
  let dir: string;
  let workspace: string;
  let deploy: string;

  const write = (path: string, content: string): void => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  };

  /** A package at `at` named `name` with `deps` as dependencies and `built` as its dist/ files. */
  const pkg = (at: string, name: string, main: string, deps: string[], built: Record<string, string>): void => {
    write(join(at, 'package.json'), JSON.stringify({
      name, main, dependencies: Object.fromEntries(deps.map((dep) => [dep, 'workspace:*'])),
    }));
    for (const [file, content] of Object.entries(built)) write(join(at, file), content);
  };

  const lib = { 'dist/index.js': 'export * from "./sub/a.js";', 'dist/sub/a.js': 'export const a = 1;' };
  const base = { 'dist/index.js': 'export const b = 2;' };
  const svc = { 'dist/src/index.js': 'import "lib";' };

  /** The pnpm virtual store directory of `name`, where its own dependencies sit beside it. */
  const store = (name: string): string => join(deploy, 'node_modules', '.pnpm', `${name}@file`, 'node_modules');

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'check-deploy-'));
    workspace = join(dir, 'app');
    deploy = join(dir, 'deploy');

    write(join(workspace, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n  - services/*\n\ninjectWorkspacePackages: true\n');
    pkg(join(workspace, 'packages/lib'), 'lib', 'dist/index.js', ['base'], lib);
    pkg(join(workspace, 'packages/base'), 'base', 'dist/index.js', [], base);
    pkg(join(workspace, 'services/svc'), 'svc', 'dist/src/index.js', ['lib'], svc);

    pkg(deploy, 'svc', 'dist/src/index.js', ['lib'], svc);
    pkg(join(store('lib'), 'lib'), 'lib', 'dist/index.js', ['base'], lib);
    pkg(join(store('base'), 'base'), 'base', 'dist/index.js', [], base);
    symlinkSync(join(store('lib'), 'lib'), join(deploy, 'node_modules', 'lib'));
    symlinkSync(join(store('base'), 'base'), join(store('lib'), 'base'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const run = () => spawnSync(process.execPath, [script, workspace, deploy], { encoding: 'utf8' });

  it('passes a tree that holds every built file of every workspace package it reaches', () => {
    const result = run();

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('3 package(s) checked');
  });

  it('fails a dependency stripped of its built files, naming each', () => {
    rmSync(join(store('lib'), 'lib', 'dist', 'sub'), { recursive: true });

    const result = run();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('lib: dist/sub/a.js is missing');
  });

  it('follows the dependencies of dependencies', () => {
    rmSync(join(store('base'), 'base', 'dist', 'index.js'));

    const result = run();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('base: dist/index.js is missing');
  });

  it('fails a built file that differs from the workspace\'s', () => {
    writeFileSync(join(store('lib'), 'lib', 'dist', 'sub', 'a.js'), '');

    expect(run().stderr).toContain('lib: dist/sub/a.js differs');
  });

  it('fails the deployed package itself short of a built file', () => {
    rmSync(join(deploy, 'dist'), { recursive: true });

    expect(run().stderr).toContain('svc: dist/src/index.js is missing');
  });

  it('fails a workspace dependency that was not deployed', () => {
    rmSync(join(deploy, 'node_modules', 'lib'));

    const result = run();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('svc: its dependency lib is not deployed');
  });

  it('fails a tree that is not a workspace package', () => {
    write(join(deploy, 'package.json'), JSON.stringify({ name: 'elsewhere' }));

    expect(run().stderr).toContain('is not a deployed workspace package');
  });
});
