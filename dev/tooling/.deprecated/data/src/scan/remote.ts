import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { RemoteConfig } from './types';
import { parseVaultPath } from './parse';

const execFileAsync = promisify(execFile);

export interface RemoteEntry {
  remote: string;
  table:  string;
  year:   string;
  day:    string;
  suffix: string;             // '' for buckets (shouldn't appear — remotes only have WS sources)
  isTmp:  boolean;
  remotePath: string;         // absolute path on the remote
}

/**
 * Lists all `.csv.gz`(`.tmp`) source files on a remote vault via SSH.
 *
 * Uses `find` with the remote's vault root as the base. Includes in-progress
 * downloads (`.tmp`) so the scanner can flag them as `downloading`. Buckets
 * (no suffix) are filtered out client-side — remotes shouldn't have them,
 * but we defend against stray data.
 */
export async function scanRemote(remote: RemoteConfig): Promise<RemoteEntry[]> {
  const stdout = await runFind(remote);
  const lines  = stdout.split('\n').map(l => l.trim()).filter(Boolean);

  const entries: RemoteEntry[] = [];

  for (const absPath of lines) {
    const rel = relativeTo(absPath, remote.path);

    if (! rel) continue;

    const parsed = parseVaultPath(rel);

    if (! parsed)             continue;
    if (parsed.suffix === '') continue;          // buckets — not expected on remotes

    entries.push({
      remote:     remote.name,
      table:      parsed.table,
      year:       parsed.year,
      day:        parsed.day,
      suffix:     parsed.suffix,
      isTmp:      parsed.isTmp,
      remotePath: absPath,
    });
  }

  return entries;
}

async function runFind(remote: RemoteConfig): Promise<string> {
  const target = `${remote.user}@${remote.host}`;
  const findCmd =
    `find ${shellQuote(remote.path)} -type f \\( -name '*.csv.gz' -o -name '*.csv.gz.tmp' \\)`;

  try {
    const { stdout } = await execFileAsync('ssh', [
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=10',
      target,
      findCmd,
    ], { maxBuffer: 64 * 1024 * 1024 });

    return stdout;
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string };
    const detail = e.stderr?.toString().trim() || e.message;

    throw new Error(`Failed to list remote "${remote.name}" (${target}): ${detail}`);
  }
}

function relativeTo(absPath: string, base: string): string | null {
  const normBase = base.replace(/\/+$/, '');

  if (! absPath.startsWith(`${normBase}/`)) return null;

  return absPath.slice(normBase.length + 1);
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
