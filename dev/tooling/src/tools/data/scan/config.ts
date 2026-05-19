import { getEnv } from '../../../shared/utils/env';
import { RemoteConfig, ScanConfig } from './types';

const DEFAULT_VAULT_DIR = '/data/bitmex/vault';

/**
 * Resolves the `ScanConfig` from environment variables.
 *
 * Required:
 *   - `SOURCES_MEGA_VAULT` — Mega path for ready buckets
 *   - `SOURCES_MEGA_RAW`   — Mega path for raw WS source files
 *
 * Optional:
 *   - `VAULT_DATA_DIR`         — local vault root (default `/data/bitmex/vault`)
 *   - `SOURCES_REMOTE_VAULTS`  — comma-separated `<name>:<user>@<host>:<path>`
 */
export function loadConfig(): ScanConfig {
  const megaVault = requiredEnv('SOURCES_MEGA_VAULT');
  const megaRaw   = requiredEnv('SOURCES_MEGA_RAW');
  const localBase = getEnv('VAULT_DATA_DIR', DEFAULT_VAULT_DIR) ?? DEFAULT_VAULT_DIR;
  const remotes   = parseRemotes(getEnv('SOURCES_REMOTE_VAULTS', '') ?? '');

  return { localBase, remotes, megaVault, megaRaw };
}

function requiredEnv(name: string): string {
  const value = getEnv(name);

  if (! value)
    throw new Error(`Missing required env var: ${name}. Set it in dev/tooling/.env`);

  return value;
}

/**
 * Parses `SOURCES_REMOTE_VAULTS`. Format:
 *
 *   `name1:user@host1:/path,name2:user@host2:/path`
 *
 * Each entry is split on the **first** colon (name vs auth+host+path), then
 * the auth+host+path part is parsed as `<user>@<host>:<path>`.
 */
export function parseRemotes(raw: string): RemoteConfig[] {
  const trimmed = raw.trim();

  if (! trimmed) return [];

  return trimmed.split(',').map(parseRemote);
}

function parseRemote(entry: string): RemoteConfig {
  const trimmed = entry.trim();
  const firstColon = trimmed.indexOf(':');

  if (firstColon === -1) {
    throw new Error(`Invalid remote entry (missing ':'): "${entry}"`);
  }

  const name = trimmed.slice(0, firstColon).trim();
  const rest = trimmed.slice(firstColon + 1).trim();

  const at = rest.indexOf('@');

  if (at === -1) {
    throw new Error(`Invalid remote "${name}" (missing '@'): "${entry}"`);
  }

  const user      = rest.slice(0, at);
  const hostPath  = rest.slice(at + 1);
  const pathColon = hostPath.indexOf(':');

  if (pathColon === -1) {
    throw new Error(`Invalid remote "${name}" (missing ':' before path): "${entry}"`);
  }

  const host = hostPath.slice(0, pathColon);
  const path = hostPath.slice(pathColon + 1);

  if (! name || ! user || ! host || ! path) {
    throw new Error(`Invalid remote "${entry}": all of name, user, host, path are required`);
  }

  return { name, user, host, path };
}
