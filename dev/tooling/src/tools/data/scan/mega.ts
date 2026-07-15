import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseMegaTar, parseVaultPath } from './parse';

const execFileAsync = promisify(execFile);

export interface MegaScan {
  /** Loose source files present in `SOURCES_MEGA_RAW` (current year). */
  raw: MegaEntry[];

  /** Loose buckets present in `SOURCES_MEGA_VAULT` (current year). */
  vault: MegaEntry[];

  /** Year tarballs found at `<SOURCES_MEGA_VAULT>/<table>/YYYY.tar` — bucket archives. */
  bucketTars: MegaTar[];

  /** Year tarballs found at `<SOURCES_MEGA_RAW>/<table>/YYYY.tar` — source archives. */
  sourceTars: MegaTar[];
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
 *
 * Both roots follow the same layout: loose daily files for the current year,
 * and one `<table>/YYYY.tar` per prior year. The only difference is what the
 * files are — sources (suffixed) under raw, buckets (suffix-less) under vault.
 */
export async function scanMega(megaVault: string, megaRaw: string): Promise<MegaScan> {
  const [rawLines, vaultLines] = await Promise.all([
    runFind(megaRaw),
    runFind(megaVault),
  ]);

  const raw   = classify(rawLines, megaRaw, 'sources');
  const vault = classify(vaultLines, megaVault, 'buckets');

  return {
    raw:        raw.files,
    vault:      vault.files,
    bucketTars: vault.tars,
    sourceTars: raw.tars,
  };
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
 * Splits one root's `mega-find` output into loose daily files and year
 * tarballs. `kind` says which loose files belong here: `sources` (suffixed,
 * raw root) or `buckets` (suffix-less, vault root). Files of the wrong shape
 * for the root are skipped — they shouldn't be there.
 */
function classify(
  lines: string[],
  base:  string,
  kind:  'sources' | 'buckets',
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

    const isSource = parsed.suffix !== '';

    if (kind === 'sources' && ! isSource) continue;   // buckets shouldn't be in raw
    if (kind === 'buckets' && isSource)   continue;    // sources shouldn't be in vault

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
