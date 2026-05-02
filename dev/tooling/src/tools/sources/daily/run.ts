import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { info, warn, error, success, section, spacer } from '../../../shared/ui/logger';
import { confirm } from '../../../shared/ui/prompts';
import { getEnv } from '../../../shared/utils/env';
import { buildSourceFile } from '../discover';
import { runDiagnose } from '../fix/run';
import { runMerge } from '../merge/run';

// ── Types ─────────────────────────────────────────────────────────────────────

interface RemoteVault {
  name:      string;
  userHost:  string;
  vaultPath: string;
}

interface TableState {
  table:       string;
  localOk:     boolean;
  remoteOk:    Record<string, boolean>;
  megaRawOk:   boolean;
  megaVaultOk: boolean;
  skipReason:  string | null;
}

interface ExecConfig {
  vaultDir:      string;
  processDir:    string;
  byproductsDir: string;
  megaRaw:       string;
  megaVault:     string;
  remotes:       RemoteVault[];
}

// ── Constants ─────────────────────────────────────────────────────────────────

const TABLES = [
  'announcement',
  'chat',
  'connected',
  'instrument',
  'liquidation',
  'orderBookL2',
  'publicNotifications',
];

// ── Entry point ───────────────────────────────────────────────────────────────

export async function runDaily(rawDate: string | null): Promise<void> {
  const date = resolveDate(rawDate);
  const year = date.slice(0, 4);

  const vaultDir      = requireEnv('VAULT_DATA_DIR', '/data/bitmex/vault');
  const dailyDir      = requireEnv('SOURCES_DAILY_DIR');
  const megaRaw       = requireEnv('SOURCES_MEGA_RAW');
  const megaVault     = requireEnv('SOURCES_MEGA_VAULT');
  const remotes       = parseRemoteVaults(requireEnv('SOURCES_REMOTE_VAULTS'));
  const processDir    = path.join(dailyDir, 'process');
  const byproductsDir = path.join(dailyDir, 'byproducts');

  if (remotes.length === 0) {
    error('SOURCES_REMOTE_VAULTS is empty — at least one remote is required.');
    process.exit(1);
  }

  // Pre-flight checks
  section(`Checking files for ${date}`);
  spacer();
  info('Checking remote files via SSH...');
  spacer();

  const states = TABLES.map(table =>
    checkTable(table, year, date, vaultDir, remotes, megaRaw, megaVault),
  );

  printPlan(states, date, remotes);

  const processable = states.filter(s => s.skipReason === null);

  if (processable.length === 0) {
    warn('No tables are processable.');
    return;
  }

  const confirmed = await confirm(`Process ${processable.length} table(s)?`);

  if (! confirmed) {
    info('Aborted.');
    return;
  }

  spacer();

  await execute(processable.map(s => s.table), date, year, {
    vaultDir, processDir, byproductsDir, megaRaw, megaVault, remotes,
  });

  spacer();
  success(`Done — ${processable.length} table(s) processed for ${date}.`);
}

// ── Pre-flight ────────────────────────────────────────────────────────────────

function checkTable(
  table:     string,
  year:      string,
  date:      string,
  vaultDir:  string,
  remotes:   RemoteVault[],
  megaRaw:   string,
  megaVault: string,
): TableState {
  const localOk  = localFileExists(vaultDir, table, year, date);
  const remoteOk: Record<string, boolean> = {};

  for (const remote of remotes) {
    remoteOk[remote.name] = remoteFileExists(remote, table, year, date);
  }

  const allSuffixes   = ['local', ...remotes.map(r => r.name)];
  const megaRawOk     = allSuffixes.every(s =>
    megaFileAbsent(`${megaRaw}/${table}/${year}/${date}.${s}.csv.gz`),
  );
  const megaVaultOk   = megaFileAbsent(`${megaVault}/${table}/${year}/${date}.csv.gz`);
  const missingRemotes = remotes.filter(r => ! remoteOk[r.name]).map(r => r.name);

  let skipReason: string | null = null;

  if (! localOk) {
    skipReason = 'local file missing or incomplete (.tmp)';
  } else if (missingRemotes.length > 0) {
    skipReason = `remote file${missingRemotes.length > 1 ? 's' : ''} missing: ${missingRemotes.join(', ')}`;
  } else if (! megaRawOk) {
    skipReason = 'already present in MEGA raw';
  } else if (! megaVaultOk) {
    skipReason = 'already present in MEGA vault';
  }

  return { table, localOk, remoteOk, megaRawOk, megaVaultOk, skipReason };
}

// ── Plan output ───────────────────────────────────────────────────────────────

function printPlan(states: TableState[], date: string, remotes: RemoteVault[]): void {
  section(`Plan for ${date}`);
  spacer();

  for (const s of states) {
    if (s.skipReason) {
      warn(s.table);
    } else {
      success(s.table);
    }

    info(`  local:       ${s.localOk ? '✓' : '✗'}`);

    for (const remote of remotes) {
      const pad  = ' '.repeat(Math.max(1, 10 - remote.name.length));
      const icon = s.remoteOk[remote.name] ? '✓' : '✗';

      info(`  ${remote.name}:${pad}${icon}`);
    }

    info(`  mega raw:    ${s.megaRawOk   ? '✓ absent' : '✗ already present'}`);
    info(`  mega vault:  ${s.megaVaultOk ? '✓ absent' : '✗ already present'}`);

    if (s.skipReason) {
      warn(`  → SKIPPED: ${s.skipReason}`);
    } else {
      info(`  → will process`);
    }

    spacer();
  }
}

// ── Execution ─────────────────────────────────────────────────────────────────

async function execute(
  tables: string[],
  date:   string,
  year:   string,
  cfg:    ExecConfig,
): Promise<void> {
  const { vaultDir, processDir, byproductsDir, megaRaw, megaVault, remotes } = cfg;
  const suffixes = ['local', ...remotes.map(r => r.name)];

  // 1. Ensure working directories
  for (const table of tables) {
    fs.mkdirSync(path.join(processDir, table, year), { recursive: true });
  }

  fs.mkdirSync(byproductsDir, { recursive: true });

  // 2. Import: rsync from remotes, move local files into process dir
  section('Importing files');
  spacer();

  for (const table of tables) {
    const tableDir = path.join(processDir, table, year);

    for (const remote of remotes) {
      const remoteSrc = `${remote.userHost}:${remote.vaultPath}/${table}/${year}/${date}.csv.gz`;
      const destPath  = path.join(tableDir, `${date}.${remote.name}.csv.gz`);

      info(`rsync ${remote.name}/${table}/${date}...`);
      execSync(`rsync -az "${remoteSrc}" "${destPath}"`, { stdio: 'inherit' });
    }

    const localSrc  = path.join(vaultDir, table, year, `${date}.csv.gz`);
    const localDest = path.join(tableDir, `${date}.local.csv.gz`);

    fs.renameSync(localSrc, localDest);
    success(`Moved local/${table}/${date}`);
  }

  spacer();

  // 3. Upload raw files to MEGA
  section('Uploading raw files to MEGA');
  spacer();

  for (const table of tables) {
    const tableDir = path.join(processDir, table, year);
    const megaDir  = `${megaRaw}/${table}/${year}`;

    execSync(`mega-mkdir -p "${megaDir}"`, { stdio: 'pipe' });

    for (const suffix of suffixes) {
      const localFile = path.join(tableDir, `${date}.${suffix}.csv.gz`);

      info(`mega-put raw ${table}/${date}.${suffix}.csv.gz...`);
      execSync(`mega-put "${localFile}" "${megaDir}"`, { stdio: 'inherit' });
    }
  }

  spacer();

  // 4. Fix pass 1 — raw files
  section('Fix pass 1 (raw)');
  spacer();

  const rawFiles = tables.flatMap(table => {
    const tableDir = path.join(processDir, table, year);

    return suffixes.map(s => buildSourceFile(path.join(tableDir, `${date}.${s}.csv.gz`)));
  });

  await runDiagnose(rawFiles, false, null);

  // 5. Move raw byproducts
  section('Moving raw byproducts');
  spacer();

  for (const table of tables) {
    const tableDir = path.join(processDir, table, year);

    for (const suffix of suffixes) {
      mv(path.join(tableDir, `${date}.${suffix}.csv.gz`), path.join(byproductsDir, `${table}.${date}.${suffix}.raw.csv.gz`));
      mv(path.join(tableDir, `${date}.${suffix}.log`),    path.join(byproductsDir, `${table}.${date}.${suffix}.raw.log`));
    }
  }

  spacer();

  // 6. Merge
  section('Merging');
  spacer();

  for (const table of tables) {
    const tableDir = path.join(processDir, table, year);

    await runMerge(tableDir, false, null, date, true);
  }

  // 7. Move fixed byproducts + merge logs
  section('Moving fixed byproducts');
  spacer();

  for (const table of tables) {
    const tableDir = path.join(processDir, table, year);

    for (const suffix of suffixes) {
      mv(path.join(tableDir, `${date}.${suffix}.fixed.csv.gz`), path.join(byproductsDir, `${table}.${date}.${suffix}.fixed.csv.gz`));
    }

    // merge log is named <day>.log by runMerge
    mv(path.join(tableDir, `${date}.log`), path.join(byproductsDir, `${table}.${date}.merge.log`));
  }

  spacer();

  // 8. Fix pass 2 — merged files
  section('Fix pass 2 (merged)');
  spacer();

  const mergedFiles = tables.map(table =>
    buildSourceFile(path.join(processDir, table, year, `${date}.merged.csv.gz`)),
  );

  await runDiagnose(mergedFiles, false, null);

  // 9. Move merged byproducts
  section('Moving merged byproducts');
  spacer();

  for (const table of tables) {
    const tableDir = path.join(processDir, table, year);

    mv(path.join(tableDir, `${date}.merged.csv.gz`), path.join(byproductsDir, `${table}.${date}.merged.csv.gz`));
    mv(path.join(tableDir, `${date}.merged.log`),    path.join(byproductsDir, `${table}.${date}.merged.log`));
  }

  spacer();

  // 10. Upload final files to MEGA vault
  section('Uploading final files to MEGA vault');
  spacer();

  for (const table of tables) {
    const tableDir  = path.join(processDir, table, year);
    const finalFile = path.join(tableDir, `${date}.merged.fixed.csv.gz`);
    const megaDir   = `${megaVault}/${table}/${year}`;

    execSync(`mega-mkdir -p "${megaDir}"`, { stdio: 'pipe' });

    info(`mega-put vault ${table}/${date}.csv.gz...`);
    execSync(`mega-put "${finalFile}" "${megaDir}"`, { stdio: 'inherit' });
  }

  spacer();

  // 11. Move final files to vault
  section('Moving final files to vault');
  spacer();

  for (const table of tables) {
    const tableDir  = path.join(processDir, table, year);
    const finalSrc  = path.join(tableDir, `${date}.merged.fixed.csv.gz`);
    const finalDest = path.join(vaultDir, table, year, `${date}.csv.gz`);

    fs.mkdirSync(path.dirname(finalDest), { recursive: true });
    fs.renameSync(finalSrc, finalDest);
    success(`${table}/${year}/${date}.csv.gz`);
  }
}

// ── File checks ───────────────────────────────────────────────────────────────

function localFileExists(vaultDir: string, table: string, year: string, date: string): boolean {
  const filePath = path.join(vaultDir, table, year, `${date}.csv.gz`);

  return fs.existsSync(filePath) && ! fs.existsSync(`${filePath}.tmp`);
}

function remoteFileExists(remote: RemoteVault, table: string, year: string, date: string): boolean {
  const p = `${remote.vaultPath}/${table}/${year}/${date}.csv.gz`;

  try {
    execSync(
      `ssh "${remote.userHost}" "test -f '${p}' && ! test -f '${p}.tmp'"`,
      { stdio: 'pipe', timeout: 15_000 },
    );
    return true;
  } catch {
    return false;
  }
}

function megaFileAbsent(megaPath: string): boolean {
  try {
    execSync(`mega-ls "${megaPath}"`, { stdio: 'pipe', timeout: 30_000 });
    return false; // exists — not what we want
  } catch {
    return true;  // absent — good
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function mv(src: string, dest: string): void {
  if (! fs.existsSync(src)) {
    warn(`Missing expected file, skipping: ${path.basename(src)}`);
    return;
  }

  fs.renameSync(src, dest);
  info(`  ${path.basename(src)} → ${path.basename(dest)}`);
}

function resolveDate(raw: string | null): string {
  if (! raw) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10).replace(/-/g, '');
  }

  return raw.replace(/-/g, '');
}

function parseRemoteVaults(raw: string): RemoteVault[] {
  if (! raw.trim()) {
    return [];
  }

  return raw.split(',').map(entry => {
    const firstColon = entry.indexOf(':');
    const name       = entry.slice(0, firstColon).trim();
    const rest       = entry.slice(firstColon + 1);    // user@host:/path
    const pathColon  = rest.indexOf(':');
    const userHost   = rest.slice(0, pathColon).trim();
    const vaultPath  = rest.slice(pathColon + 1).trim();

    return { name, userHost, vaultPath };
  });
}

function requireEnv(key: string, defaultValue?: string): string {
  const val = getEnv(key, defaultValue);

  if (! val) {
    error(`Missing required environment variable: ${key}`);
    process.exit(1);
  }

  return val;
}

// ── Test exports ──────────────────────────────────────────────────────────────

export const _test_resolveDate       = resolveDate;
export const _test_parseRemoteVaults = parseRemoteVaults;
