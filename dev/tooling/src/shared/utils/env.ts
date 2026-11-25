import fs from 'node:fs';
import path from 'node:path';
import { warn } from '../ui/logger';

// Paths are identical whether running from src/ or dist/ since both sit at
// the same depth (dev/tooling/{src|dist}/shared/utils/).
const ROOT_DIR = path.resolve(__dirname, '../../../../..');
const TOOLING_DIR = path.resolve(__dirname, '../../..');

/** What one .env file sets, and which of its keys hold a single-quoted, never-expanded value. */
interface EnvFile {
  values: Record<string, string>;
  literal: Set<string>;
}

const ASSIGNMENT = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=(.*)$/;

/** Nothing, or a comment, after a closing quote. */
const AFTER_QUOTE = /^(?:\s*|\s+#.*)$/;

const ESCAPES: Record<string, string> = { n: '\n', '"': '"', '\\': '\\' };

/**
 * One value as written after `=`. A value in single quotes is taken as written; one in double
 * quotes has `\n`, `\"` and `\\` unescaped. Either may hold `#`, and may be followed by a comment.
 * An unquoted value ends at a `#` that follows whitespace, as docker compose reads it; a `#` with
 * nothing before it is part of the value.
 */
function parseValue(raw: string): { value: string; quoted: "'" | '"' | null } {
  const text = raw.trimStart();
  const quote = text[0];

  if (quote === "'") {
    const end = text.indexOf("'", 1);

    if (end !== -1 && AFTER_QUOTE.test(text.slice(end + 1))) {
      return { value: text.slice(1, end), quoted: "'" };
    }
  } else if (quote === '"') {
    let value = '';

    for (let i = 1; i < text.length; i++) {
      const ch = text[i];

      if (ch === '\\' && i + 1 < text.length) {
        const next = text[i + 1];
        value += ESCAPES[next] ?? ch + next;
        i++;
      } else if (ch === '"') {
        if (AFTER_QUOTE.test(text.slice(i + 1))) return { value, quoted: '"' };
        break;
      } else {
        value += ch;
      }
    }
  }

  // Unquoted, or a quote that does not close the value: read it as written.
  return { value: raw.replace(/\s+#.*$/, '').trim(), quoted: null };
}

function readEnvFile(filePath: string): EnvFile {
  const file: EnvFile = { values: {}, literal: new Set() };

  if (! fs.existsSync(filePath)) return file;

  for (const line of fs.readFileSync(filePath, 'utf-8').split(/\r?\n/)) {
    if (/^\s*(?:#|$)/.test(line)) continue;

    // Lines without a `KEY=` assignment are skipped.
    const match = ASSIGNMENT.exec(line);

    if (! match) continue;

    const [, key, raw] = match;
    const { value, quoted } = parseValue(raw);

    file.values[key] = value;

    if (quoted === "'") file.literal.add(key);
    else file.literal.delete(key);
  }

  return file;
}

/**
 * The variables a .env file sets, `{}` for a file that does not exist. Lines are `KEY=value`,
 * optionally prefixed with `export`; blank lines and `#` comment lines are skipped. Values are
 * read as docker compose reads them: see `parseValue` for quoting and inline comments. `${VAR}`
 * references are left as written.
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
 * once. Values the shell exported, and single-quoted values, are used as given. A reference that
 * leads back to itself is left as written.
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

  const resolve = (key: string, resolving: Set<string>): string => {
    if (! expandable.has(key)) return merged[key];

    const done = resolved.get(key);

    if (done !== undefined) return done;

    resolving.add(key);

    const value = merged[key].replace(/\$\{([^}]+)\}/g, (match, name: string) => {
      if (resolving.has(name)) return match;

      if (! (name in merged)) {
        if (! unresolved.has(name)) warn(`\${${name}} is not set; it expands to an empty string`);
        unresolved.add(name);

        return '';
      }

      return resolve(name, resolving);
    });

    resolving.delete(key);
    resolved.set(key, value);

    return value;
  };

  for (const key of expandable) merged[key] = resolve(key, new Set());

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
