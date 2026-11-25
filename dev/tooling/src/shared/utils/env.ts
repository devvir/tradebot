import fs from 'node:fs';
import path from 'node:path';

// Paths are identical whether running from src/ or dist/ since both sit at
// the same depth (dev/tooling/{src|dist}/shared/utils/).
const rootDir = path.resolve(__dirname, '../../../../..');
const moduleDir = path.resolve(__dirname, '../../..');

function parseEnvFile(filePath: string): Record<string, string> {
  if (! fs.existsSync(filePath)) {
    return {};
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  const env: Record<string, string> = {};

  content.split('\n').forEach(line => {
    line = line.trim();

    if (! line || line.startsWith('#')) {
      return;
    }

    const [key, ...valueParts] = line.split('=');

    // Skip malformed lines that have no = separator
    if (key && valueParts.length > 0) {
      // A # after whitespace starts a comment, as it does for docker compose;
      // one with nothing before it is part of the value.
      env[key.trim()] = valueParts.join('=').replace(/\s+#.*$/, '').trim();
    }
  });

  return env;
}

/**
 * What the shell exported, as opposed to what `loadEnv` merged in from .env files: process.env as
 * it stood when `loadEnv` last ran, without the values an earlier call wrote.
 */
let shellEnv: Record<string, string> | null = null;

/** The values `loadEnv` wrote into process.env that the shell had not set. */
let loadedEnv: Record<string, string> = {};

/**
 * Load environment variables in order of precedence (lowest → highest):
 * ./.env → ./modules/<module>/.env (if -m) → <custom> (if -e) → ./dev/tooling/.env → process.env
 */
export function loadEnv(additionalEnvPath: string | null = null, moduleName: string | null = null): Record<string, string> {
  const rootEnv = parseEnvFile(path.join(rootDir, '.env'));
  const moduleEnv = moduleName ? parseEnvFile(path.join(rootDir, 'modules', moduleName, '.env')) : {};
  const additionalEnv = additionalEnvPath ? parseEnvFile(additionalEnvPath) : {};
  const toolingEnv = parseEnvFile(path.join(moduleDir, '.env'));

  const shell: Record<string, string> = {};

  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && loadedEnv[k] !== v) shell[k] = v;
  }

  shellEnv = shell;

  const merged: Record<string, string> = {
    ...rootEnv,
    ...moduleEnv,
    ...additionalEnv,
    ...toolingEnv,
  };

  // process.env values override everything
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) merged[k] = v;
  }

  // Resolve ${VAR} references (single pass, unresolved refs stay as-is)
  for (const key of Object.keys(merged)) {
    merged[key] = merged[key].replace(/\$\{([^}]+)\}/g, (_match, varName) => {
      return merged[varName] ?? '';
    });
  }

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
 * files. Before `loadEnv` has run, that is everything in process.env. The value returned is the
 * current one, with `${VAR}` references resolved.
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
