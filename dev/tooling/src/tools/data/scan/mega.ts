import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseMegaTar, parseVaultPath } from './parse';

const execFileAsync = promisify(execFile);

export interface MegaScan {
  /** Source files present in `SOURCES_MEGA_RAW`. */
  raw: MegaEntry[];

  /** Buckets present in `SOURCES_MEGA_VAULT`. */
  vault: MegaEntry[];

  /** Year tarballs found at `<SOURCES_MEGA_VAULT>/<table>/YYYY.tar`. */
  tars: MegaTar[];
}

export interface MegaEntry {
  table:  string;
  year:   string;
  day:    string;
  suffix: string;            // '' for vault buckets; collector name for raw source files
}

export interface MegaTar {
  table: string;
  year:  number;
}

/**
 * Verifies `mega-cmd` is installed and the session is authenticated.
 *
 * Throws with an actionable message if either check fails — the command never
 * attempts to log in programmatically.
 */
export async function checkMegaAvailable(): Promise<void> {
  try {
    await execFileAsync('mega-whoami', []);
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string; code?: string };

    if (e.code === 'ENOENT') {
      throw new Error(
        'mega-cmd is not installed (mega-whoami not found in PATH). ' +
        'Install it from https://mega.io/cmd, then run `mega-login` to authenticate.',
      );
    }

    const detail = e.stderr?.toString().trim() || e.message;

    throw new Error(
      `mega-cmd is not authenticated: ${detail}\n` +
      `Run \`mega-login <email> <password>\` first, then retry.`,
    );
  }
}

/**
 * Lists everything under `megaVault` and `megaRaw` in a single pass each,
 * then classifies the entries by parsing their relative paths.
 */
export async function scanMega(megaVault: string, megaRaw: string): Promise<MegaScan> {
  const [rawLines, vaultLines] = await Promise.all([
    runFind(megaRaw),
    runFind(megaVault),
  ]);

  const raw   = classifyRaw(rawLines, megaRaw);
  const vault = classifyVault(vaultLines, megaVault).buckets;
  const tars  = classifyVault(vaultLines, megaVault).tars;

  return { raw, vault, tars };
}

async function runFind(megaBase: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync('mega-find', [megaBase], {
      maxBuffer: 256 * 1024 * 1024,
    });

    return stdout.split('\n').map(l => l.trim()).filter(Boolean);
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string };
    const detail = e.stderr?.toString().trim() || e.message;

    throw new Error(`mega-find failed for "${megaBase}": ${detail}`);
  }
}

function classifyRaw(lines: string[], base: string): MegaEntry[] {
  const out: MegaEntry[] = [];

  for (const absPath of lines) {
    const rel = relativeTo(absPath, base);

    if (! rel) continue;

    const parsed = parseVaultPath(rel);

    if (! parsed)             continue;
    if (parsed.suffix === '') continue;          // buckets shouldn't be in raw

    out.push({
      table:  parsed.table,
      year:   parsed.year,
      day:    parsed.day,
      suffix: parsed.suffix,
    });
  }

  return out;
}

function classifyVault(
  lines: string[],
  base:  string,
): { buckets: MegaEntry[]; tars: MegaTar[] } {
  const buckets: MegaEntry[] = [];
  const tars:    MegaTar[]   = [];

  for (const absPath of lines) {
    const rel = relativeTo(absPath, base);

    if (! rel) continue;

    const tar = parseMegaTar(rel);

    if (tar) {
      tars.push(tar);
      continue;
    }

    const parsed = parseVaultPath(rel);

    if (! parsed)             continue;
    if (parsed.suffix !== '') continue;         // sources shouldn't be in vault

    buckets.push({
      table:  parsed.table,
      year:   parsed.year,
      day:    parsed.day,
      suffix: '',
    });
  }

  return { buckets, tars };
}

function relativeTo(absPath: string, base: string): string | null {
  const normBase = base.replace(/\/+$/, '');

  if (absPath === normBase)                 return null;
  if (! absPath.startsWith(`${normBase}/`)) return null;

  return absPath.slice(normBase.length + 1);
}
