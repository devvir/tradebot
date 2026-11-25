/**
 * Checks a `pnpm deploy` tree against the workspace it was deployed from:
 *
 *   node check-deploy.mjs <workspace root> <deploy dir>
 *
 * The deployed package and every workspace package it reaches through its
 * production dependencies, at any depth, must hold every file its workspace
 * source holds in the directory of its `main` (dist/ for a package whose main
 * is dist/index.js), at the same size. A copy short of a file is one an ignore
 * file of the package stripped, so this exits 1 and names each missing file.
 */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

const [workspaceRoot, deployDir] = process.argv.slice(2);
if (!workspaceRoot || !deployDir) {
  console.error('usage: check-deploy.mjs <workspace root> <deploy dir>');
  process.exit(2);
}

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

/** The `packages:` globs of pnpm-workspace.yaml: each a directory, or a directory ending in `/*`. */
const workspaceGlobs = () => {
  const lines = readFileSync(join(workspaceRoot, 'pnpm-workspace.yaml'), 'utf8').split('\n');
  const start = lines.findIndex((line) => /^packages:\s*$/.test(line));
  const globs = [];
  for (const line of lines.slice(start + 1)) {
    const item = line.match(/^\s+-\s+['"]?([^'"\s]+)['"]?\s*$/);
    if (!item) break;
    globs.push(item[1]);
  }

  return globs;
};

/** Workspace package name → its directory in the workspace. */
const sources = new Map();
for (const glob of workspaceGlobs()) {
  const dirs = glob.endsWith('/*')
    ? (existsSync(join(workspaceRoot, glob.slice(0, -2)))
      ? readdirSync(join(workspaceRoot, glob.slice(0, -2)), { withFileTypes: true })
        .filter((entry) => entry.isDirectory()).map((entry) => join(workspaceRoot, glob.slice(0, -2), entry.name))
      : [])
    : [join(workspaceRoot, glob)];
  for (const dir of dirs) {
    if (existsSync(join(dir, 'package.json'))) sources.set(readJson(join(dir, 'package.json')).name, dir);
  }
}

/** Every file under `dir`, relative to it. */
const files = (dir) => readdirSync(dir, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => relative(dir, join(entry.parentPath, entry.name)));

/** Where `name` resolves from the package at `from`: the nearest node_modules/<name> up the tree. */
const locate = (name, from) => {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate);
    if (dirname(dir) === dir) return undefined;
  }
};

const problems = [];
const checked = new Set();

const check = (deployed) => {
  if (checked.has(deployed)) return;
  checked.add(deployed);

  const manifest = readJson(join(deployed, 'package.json'));
  const source = sources.get(manifest.name);
  if (!source) return;

  const built = (manifest.main ?? 'dist/index.js').split('/').filter((part) => part && part !== '.')[0];
  const sourceBuilt = join(source, built);
  if (!existsSync(sourceBuilt)) {
    problems.push(`${manifest.name}: ${built}/ was never built in the workspace`);
  } else {
    for (const file of files(sourceBuilt)) {
      const copy = join(deployed, built, file);
      if (!existsSync(copy)) problems.push(`${manifest.name}: ${built}/${file} is missing`);
      else if (statSync(copy).size !== statSync(join(sourceBuilt, file)).size) problems.push(`${manifest.name}: ${built}/${file} differs`);
    }
  }

  for (const name of Object.keys(manifest.dependencies ?? {})) {
    if (!sources.has(name)) continue;
    const dependency = locate(name, deployed);
    if (dependency) check(dependency);
    else problems.push(`${manifest.name}: its dependency ${name} is not deployed`);
  }
};

check(realpathSync(deployDir));

if (checked.size === 0 || !sources.has(readJson(join(deployDir, 'package.json')).name)) {
  problems.push(`${deployDir} is not a deployed workspace package`);
}

if (problems.length > 0) {
  console.error(`the deployed tree in ${deployDir} is incomplete:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}

console.log(`deployed tree complete: ${checked.size} package(s) checked`);
