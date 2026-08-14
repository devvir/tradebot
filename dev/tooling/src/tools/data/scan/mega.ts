import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseMegaTar, parseVaultPath } from './parse';

const execFileAsync = promisify(execFile);

export interface MegaScan {
  /** Loose buckets present in `SOURCES_MEGA_VAULT` (current year). */
  vault: MegaEntry[];

  /** Year tarballs found at `<SOURCES_MEGA_VAULT>/<table>/YYYY.tar` — bucket archives. */
  bucketTars: MegaTar[];
}

export interface MegaEntry {
  table:  string;
  year:   string;
  day:    string;
  suffix: string;            // always '' — a bucket carries no collector name
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
 * Lists everything under `megaVault` in a single pass, then classifies the
 * entries by parsing their relative paths.
 *
 * The root holds loose daily buckets for the current year and one
 * `<table>/YYYY.tar` per prior year.
 *
 * **Buckets are all that is backed up.** A second root once held the raw WS
 * sources a bucket was built from, and both had to be present for a day to
 * count as stored. Source backup was retired with BitMEX collection itself, so
 * the bucket is the artifact and there is nothing to pair it with.
 */
export async function scanMega(megaVault: string): Promise<MegaScan> {
  const vault = classify(await runFind(megaVault), megaVault);

  return { vault: vault.files, bucketTars: vault.tars };
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

/**
 * Splits the root's `mega-find` output into loose daily buckets and year
 * tarballs. A suffixed file is a raw source, which nothing puts here — it is
 * skipped rather than counted as a bucket it is not.
 */
function classify(
  lines: string[],
  base:  string,
): { files: MegaEntry[]; tars: MegaTar[] } {
  const files: MegaEntry[] = [];
  const tars:  MegaTar[]   = [];

  for (const absPath of lines) {
    const rel = relativeTo(absPath, base);

    if (! rel) continue;

    const tar = parseMegaTar(rel);

    if (tar) {
      tars.push(tar);
      continue;
    }

    const parsed = parseVaultPath(rel);

    if (! parsed) continue;

    if (parsed.suffix !== '') continue;   // a source; nothing writes those here

    files.push({
      table:  parsed.table,
      year:   parsed.year,
      day:    parsed.day,
      suffix: parsed.suffix,
    });
  }

  return { files, tars };
}

function relativeTo(absPath: string, base: string): string | null {
  const normBase = base.replace(/\/+$/, '');

  if (absPath === normBase)                 return null;
  if (! absPath.startsWith(`${normBase}/`)) return null;

  return absPath.slice(normBase.length + 1);
}
