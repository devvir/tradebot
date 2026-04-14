import fs from 'node:fs';
import path from 'node:path';
import { confirm } from '../../../shared/ui/prompts';
import { info, warn, error, success, section, spacer } from '../../../shared/ui/logger';
import type { FilePair, Message } from '../types';
import { getTableConfig } from '../config';
import { buildHeader } from '../headers';
import { readFirstLine, streamMessages } from '../reader';
import { createGzipWriter, createNullWriter } from '../writer';
import { mergeTable } from './algorithm';
import {
  gapsDirFromVaultDir,
  collectFiles,
  buildFilePairs,
} from '../discover';

// ── Entry point ───────────────────────────────────────────────────────────────

export async function runMerge(
  vaultDir:  string,
  scope:     string | null,
  isDryRun:  boolean,
  logDir:    string | null,
): Promise<void> {
  const pairs = resolvePairs(vaultDir, scope);

  if (pairs.length === 0) {
    warn('No paired files found. Nothing to merge.');
    return;
  }

  for (const pair of pairs) {
    await processPair(pair, isDryRun, logDir);
  }
}

// ── Pair resolution ──────────────────────────────────────────────────────────

/**
 * Resolve merge pairs from the vault directory.
 * Files without a gaps counterpart are skipped with a warning — not an error.
 */
function resolvePairs(vaultDir: string, scope: string | null): FilePair[] {
  if (scope) {
    return resolveScopedPairs(vaultDir, scope);
  }

  return resolveAllPairs(vaultDir);
}

/** No scope: iterate gaps directory and pair each gaps file with its vault counterpart. */
function resolveAllPairs(vaultDir: string): FilePair[] {
  let gapsDir: string;

  try {
    gapsDir = gapsDirFromVaultDir(vaultDir);
  } catch (err) {
    error((err as Error).message);
    process.exit(1);
  }

  if (! fs.existsSync(gapsDir)) {
    error(`Gaps directory not found: ${gapsDir}`);
    process.exit(1);
  }

  const gapsFiles = collectFiles(gapsDir, null);

  if (gapsFiles.length === 0) {
    return [];
  }

  const rawPairs = buildFilePairs(vaultDir, gapsDir, gapsFiles);
  const pairs: FilePair[] = [];

  for (let i = 0; i < rawPairs.length; i++) {
    const pair = rawPairs[i];

    if (! pair) {
      warn(`No vault file found for: ${gapsFiles[i]} — skipping.`);
      continue;
    }

    pairs.push(pair);
  }

  return pairs;
}

/**
 * Scope given: iterate vault files matching the scope.
 * Vault files without a gaps counterpart are skipped with a warning.
 */
function resolveScopedPairs(vaultDir: string, scope: string): FilePair[] {
  const vaultFiles = collectFiles(vaultDir, scope);

  if (vaultFiles.length === 0) {
    error(`No vault files found matching scope: ${scope}`);
    process.exit(1);
  }

  let gapsDir: string | null = null;

  try {
    const candidate = gapsDirFromVaultDir(vaultDir);

    if (fs.existsSync(candidate)) {
      gapsDir = candidate;
    }
  } catch {
    // Gaps dir derivation failed.
  }

  if (! gapsDir) {
    for (const vaultPath of vaultFiles) {
      warn(`No gaps directory found — skipping: ${vaultPath}`);
    }

    return [];
  }

  const pairs: FilePair[] = [];

  for (const vaultPath of vaultFiles) {
    const gapsPath = findGapsCounterpart(gapsDir, vaultDir, vaultPath);

    if (! gapsPath) {
      warn(`No gaps file found for: ${vaultPath} — skipping.`);
      continue;
    }

    const rel        = path.relative(vaultDir, vaultPath);
    const tableName  = rel.split(path.sep)[0] ?? 'unknown';
    const outputPath = vaultPath.replace(/\.csv(\.gz)?$/, '.merged.csv.gz');

    pairs.push({ basePath: vaultPath, gapsPath, outputPath, tableName });
  }

  return pairs;
}

/**
 * Find a gaps file matching a vault file, trying both .csv and .csv.gz extensions.
 * Returns the first match or null.
 */
function findGapsCounterpart(gapsDir: string, vaultDir: string, vaultPath: string): string | null {
  const rel        = path.relative(vaultDir, vaultPath);
  const withoutExt = rel.replace(/\.csv(\.gz)?$/, '');

  for (const ext of ['.csv', '.csv.gz']) {
    const candidate = path.join(gapsDir, withoutExt + ext);

    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

// ── Per-pair merge processing ─────────────────────────────────────────────────

async function processPair(pair: FilePair, isDryRun: boolean, logDir: string | null): Promise<void> {
  const label = path.relative(process.cwd(), pair.basePath);

  section(label);
  spacer();

  printPairInfo(pair, isDryRun);

  if (! isDryRun) {
    if (fs.existsSync(pair.outputPath)) {
      warn(`Output already exists: ${pair.outputPath}`);
      warn('Delete it first if you want to re-merge.');
      spacer();
      return;
    }
  }

  const proceed = await confirm(isDryRun ? 'Run dry-run analysis?' : 'Proceed with merge?');

  if (! proceed) {
    info('Skipped.');
    spacer();
    return;
  }

  spacer();

  let result: { written: number; warnings: string[] };

  try {
    result = await executePair(pair, isDryRun);
  } catch (err) {
    error((err as Error).message);
    process.exit(1);
  }

  printResult(result.written, result.warnings, isDryRun);
  spacer();

  writeMergeLog(logDir ?? path.dirname(pair.basePath), pair, result.written, result.warnings, isDryRun);
}

function printPairInfo(pair: FilePair, isDryRun: boolean): void {
  info(`Table:  ${pair.tableName}`);
  info(`Base:   ${pair.basePath}  (${fileSizeMb(pair.basePath)} MB)`);
  info(`Gaps:   ${pair.gapsPath!}  (${fileSizeMb(pair.gapsPath!)} MB)`);

  if (! isDryRun) {
    info(`Output: ${pair.outputPath}`);
  }

  spacer();
}

async function executePair(pair: FilePair, isDryRun: boolean): Promise<{ written: number; warnings: string[] }> {
  const cfg = getTableConfig(pair.tableName);

  // Pre-validate: both files must start with a valid header row. Merge refuses
  // to operate on headerless files — that's a pre-existing `fix` problem.
  const baseHeaderLine = await validateMergeHeader(pair.basePath);

  await validateMergeHeader(pair.gapsPath!);

  const baseColumns = baseHeaderLine.split(',').map(c => c.trim());
  const baseHeader  = buildHeader(baseColumns, pair.basePath);

  if (cfg.timestampCol && ! baseHeader.hasTimestamp) {
    throw new Error(
      `${pair.basePath}: expected a "${cfg.timestampCol}" column for table "${pair.tableName}" ` +
      `but it was not found in the header.`,
    );
  }

  const writer = isDryRun
    ? createNullWriter()
    : createGzipWriter(pair.outputPath);

  writer.writeHeader(baseHeader);

  const result = await executeTable(pair, cfg.timestampCol, writer.writeMessage.bind(writer));

  await writer.close();

  return result;
}

/**
 * Validate that a file starts with a `_date_,` header row.
 * Returns the first line on success; throws a descriptive error pointing to
 * `fix` if the file is malformed.
 */
async function validateMergeHeader(filePath: string): Promise<string> {
  const firstLine = await readFirstLine(filePath);

  if (! firstLine.startsWith('_date_,')) {
    throw new Error(
      `${filePath}: first line does not start with "_date_," — the file may be corrupt or unsorted.\n` +
      `Run \`sources fix\` on it first, then retry the merge.`,
    );
  }

  return firstLine;
}

async function executeTable(
  pair:         FilePair,
  timestampCol: string | null,
  write:        (msg: Message) => Promise<void>,
): Promise<{ written: number; warnings: string[] }> {
  // Merge requires both files to start with a valid header row — pre-validated
  // by `validateMergeHeader`. Tell csv-parse to consume line 1 as the header.
  const aMessages = streamMessages(pair.basePath,  true);
  const bMessages = streamMessages(pair.gapsPath!, true);

  return mergeTable(aMessages, bMessages, write, {
    timestampCol,
    fileLabels: { a: pair.basePath, b: pair.gapsPath! },
  });
}

function printResult(written: number, warnings: string[], isDryRun: boolean): void {
  if (warnings.length > 0) {
    for (const w of warnings) {
      warn(w);
    }

    spacer();
  }

  const verb = isDryRun ? 'Would write' : 'Written';

  success(`${verb}: ${written.toLocaleString()} messages`);
}

function writeMergeLog(
  logDir:   string,
  pair:     FilePair,
  written:  number,
  warnings: string[],
  isDryRun: boolean,
): void {
  const base    = path.basename(pair.basePath).replace(/\.csv(\.gz)?$/, '.log');
  const logPath = path.join(logDir, base);

  try {
    fs.mkdirSync(logDir, { recursive: true });
  } catch {
    warn(`Cannot create log directory: ${logDir}`);
    return;
  }

  const lines: string[] = [
    `Base:  ${pair.basePath}`,
    `Gaps:  ${pair.gapsPath!}`,
    `Table: ${pair.tableName}`,
    '',
  ];

  if (warnings.length > 0) {
    lines.push('Warnings:');

    for (const w of warnings) {
      lines.push(`  ${w}`);
    }

    lines.push('');
  }

  const verb = isDryRun ? 'Would write' : 'Written';

  lines.push(`${verb}: ${written.toLocaleString()} messages`);

  try {
    fs.writeFileSync(logPath, lines.join('\n') + '\n');
    info(`Log: ${logPath}`);
  } catch {
    warn(`Failed to write merge log: ${logPath}`);
  }
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function fileSizeMb(filePath: string): string {
  try {
    const bytes = fs.statSync(filePath).size;

    return (bytes / (1024 * 1024)).toFixed(1);
  } catch {
    return '?';
  }
}

// ── Test exports ──────────────────────────────────────────────────────────────

export const _test_executePair = executePair;
