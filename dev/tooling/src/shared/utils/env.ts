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
      env[key.trim()] = valueParts.join('=').trim();
    }
  });

  return env;
}

/**
 * Load environment variables in order of precedence (lowest → highest):
 * ./.env → ./modules/<module>/.env (if -m) → <custom> (if -e) → ./dev/tooling/.env → process.env
 */
export function loadEnv(additionalEnvPath: string | null = null, moduleName: string | null = null): Record<string, string> {
  const rootEnv = parseEnvFile(path.join(rootDir, '.env'));
  const moduleEnv = moduleName ? parseEnvFile(path.join(rootDir, 'modules', moduleName, '.env')) : {};
  const additionalEnv = additionalEnvPath ? parseEnvFile(additionalEnvPath) : {};
  const toolingEnv = parseEnvFile(path.join(moduleDir, '.env'));

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

  Object.assign(process.env, merged);

  return merged;
}

export function getEnv(key: string, defaultValue?: string): string | undefined {
  return process.env[key] ?? defaultValue;
}

// Exported for testing
export { parseEnvFile };
