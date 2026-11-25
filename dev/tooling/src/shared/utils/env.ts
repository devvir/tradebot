import fs from 'node:fs';
import path from 'node:path';
import { parseEnv, type EnvFile } from '@tradebot/utils/env';
import { warn } from '../ui/logger';

// Paths are identical whether running from src/ or dist/ since both sit at
// the same depth (dev/tooling/{src|dist}/shared/utils/).
const ROOT_DIR = path.resolve(__dirname, '../../../../..');
const TOOLING_DIR = path.resolve(__dirname, '../../..');

/** What one .env file sets, `parseEnv`'s reading of it; nothing for a file that does not exist. */
function readEnvFile(filePath: string): EnvFile {
  if (! fs.existsSync(filePath)) return { values: {}, literal: new Set() };

  return parseEnv(fs.readFileSync(filePath, 'utf-8'));
}

/**
 * The variables a .env file sets, `{}` for a file that does not exist, read by docker compose's
 * .env grammar as `@tradebot/utils`' `parseEnv` gives it, so a value comes out as compose gives it
 * to the containers. `${VAR}` references are left as written.
 */
function parseEnvFile(filePath: string): Record<string, string> {
  return readEnvFile(filePath).values;
}

/** The .env file of the module `-m <name>` names: `modules/<name>/.env`, else `modules/<group>/<name>/.env`. */
function moduleEnvPath(rootDir: string, name: string): string {
  if (! name || path.isAbsolute(name) || name.split(/[\\/]+/).includes('..')) {
    throw new Error(`--module ${name}: name a module as <name> or <group>/<name> under modules/`);
  }

  const modulesDir = path.join(rootDir, 'modules');
  const isDir = (dir: string) => fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory() ?? false;

  let dir = path.join(modulesDir, name);

  if (! isDir(dir)) {
    const groups = isDir(modulesDir)
      ? fs.readdirSync(modulesDir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort()
      : [];
    const matches = groups.map(group => path.join(modulesDir, group, name)).filter(isDir);
    const rel = (p: string) => path.relative(rootDir, p);

    if (matches.length === 0) {
      throw new Error(`--module ${name}: no modules/${name} or modules/<group>/${name} directory`);
    }

    if (matches.length > 1) {
      throw new Error(`--module ${name} is ambiguous (${matches.map(rel).join(', ')}): name it as <group>/${name}`);
    }

    dir = matches[0];
  }

  const envPath = path.join(dir, '.env');

  if (! fs.existsSync(envPath)) {
    throw new Error(`--module ${name}: ${path.relative(rootDir, envPath)} not found`);
  }

  return envPath;
}

/**
 * What the shell exported, as opposed to what `loadEnv` merged in from .env files: process.env as
 * it stood when `loadEnv` last ran, without the values an earlier call wrote.
 */
let shellEnv: Record<string, string> | null = null;

/** The values `loadEnv` wrote into process.env that the shell had not set. */
let loadedEnv: Record<string, string> = {};

export interface EnvDirs {
  /** The repository root, holding `.env` and `modules/`. */
  rootDir?: string;
  /** The tooling package, holding its own `.env`. */
  toolingDir?: string;
}

/**
 * Load the .env files into process.env and return the merged variables. Layers, lowest to
 * highest precedence:
 *
 * 1. `<root>/.env`
 * 2. the `-m` module's .env (`modules/<name>/.env`, else the one `modules/<group>/<name>/.env`)
 * 3. `dev/tooling/.env`
 * 4. the `-e` file
 * 5. process.env, i.e. what the shell exported
 *
 * Missing root and tooling files are skipped. A missing `-e` file, or a `-m` name that does not
 * name exactly one module with a .env, throws.
 *
 * `${VAR}` references in values that come from the files are expanded against the merged
 * variables, recursively; a reference to an unset variable becomes empty and is warned about
 * once. Values the shell exported, and single-quoted values, are used as given. A key whose
 * references lead back to itself, directly or through other keys, keeps its value as written, as
 * does every other key on that cycle; a key that only refers to one of them takes that value.
 * The expansion is done here, over the merged layers, rather than file by file as
 * `@tradebot/utils`' `parseEnvFile` does, because a reference may name a key another layer sets.
 */
export function loadEnv(
  additionalEnvPath: string | null = null,
  moduleName: string | null = null,
  dirs: EnvDirs = {},
): Record<string, string> {
  const rootDir = dirs.rootDir ?? ROOT_DIR;
  const toolingDir = dirs.toolingDir ?? TOOLING_DIR;

  if (additionalEnvPath && ! fs.existsSync(additionalEnvPath)) {
    throw new Error(`--env file not found: ${additionalEnvPath}`);
  }

  const layers = [
    readEnvFile(path.join(rootDir, '.env')),
    moduleName ? readEnvFile(moduleEnvPath(rootDir, moduleName)) : null,
    readEnvFile(path.join(toolingDir, '.env')),
    additionalEnvPath ? readEnvFile(additionalEnvPath) : null,
  ];

  const shell: Record<string, string> = {};

  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && loadedEnv[k] !== v) shell[k] = v;
  }

  shellEnv = shell;

  // Values an earlier call wrote stay in place until a file sets them again.
  const merged: Record<string, string> = {};

  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) merged[k] = v;
  }

  const fromFiles: Record<string, string> = {};
  const literal = new Set<string>();

  for (const layer of layers) {
    if (! layer) continue;

    for (const [k, v] of Object.entries(layer.values)) {
      fromFiles[k] = v;

      if (layer.literal.has(k)) literal.add(k);
      else literal.delete(k);
    }
  }

  const expandable = new Set<string>();

  for (const [k, v] of Object.entries(fromFiles)) {
    if (k in shell) continue;

    merged[k] = v;

    if (! literal.has(k)) expandable.add(k);
  }

  const resolved = new Map<string, string>();
  const unresolved = new Set<string>();
  /** The keys being expanded, outermost first. */
  const resolving: string[] = [];
  /** Keys whose references lead back to themselves; each keeps its value as written. */
  const cyclic = new Set<string>();

  const resolve = (key: string): string => {
    if (! expandable.has(key)) return merged[key];

    const done = resolved.get(key);

    if (done !== undefined) return done;

    resolving.push(key);

    const expanded = merged[key].replace(/\$\{([^}]+)\}/g, (match, name: string) => {
      const open = resolving.indexOf(name);

      if (open !== -1) {
        // Every key from `name` down to this one is on the cycle.
        for (const k of resolving.slice(open)) cyclic.add(k);

        return match;
      }

      if (! (name in merged)) {
        if (! unresolved.has(name)) warn(`\${${name}} is not set; it expands to an empty string`);
        unresolved.add(name);

        return '';
      }

      return resolve(name);
    });

    resolving.pop();

    const value = cyclic.has(key) ? merged[key] : expanded;

    resolved.set(key, value);

    return value;
  };

  for (const key of expandable) merged[key] = resolve(key);

  loadedEnv = {};

  for (const [k, v] of Object.entries(merged)) {
    if (! (k in shell)) loadedEnv[k] = v;
  }

  Object.assign(process.env, merged);

  return merged;
}

export function getEnv(key: string, defaultValue?: string): string | undefined {
  return process.env[key] ?? defaultValue;
}

/**
 * Read an env var only if the shell exported it, ignoring anything `loadEnv` merged in from .env
 * files. Before `loadEnv` has run, that is everything in process.env. The value is the one the
 * shell exported: `loadEnv` neither replaces nor expands it.
 */
export function getShellEnv(key: string): string | undefined {
  if (shellEnv && ! (key in shellEnv)) return undefined;

  return process.env[key];
}

/**
 * Read an env var that MUST be set. Throws a clear error naming the variable
 * when it's missing or empty, instead of letting a hardcoded fallback in the
 * consumer make the value un-configurable.
 */
export function requiredEnv(key: string): string {
  const value = process.env[key];

  if (! value) throw new Error(`${key} is not set — define it in .env`);

  return value;
}

// Exported for testing
export { parseEnvFile };
