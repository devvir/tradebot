import fs from 'node:fs';
import path from 'node:path';
import { info, warn, success, section, spacer } from '../../../shared/ui/logger';
import { getTableConfig, getVaultColumns } from '../config';
import { buildHeader } from '../headers';
import { readFirstLine } from '../reader';
import { createGzipWriter, createNullWriter, type Writer } from '../writer';
import type { Header, SourceFile } from '../types';
import type { FileCheck, MessageCheck, CheckContext } from '../checks/types';
import { createIssueSummary, addToSummary, mergeSummaries } from '../checks/types';
import { headerCheck, midStreamHeaderCheck } from '../checks/header';
import { createDuplicateCheck } from '../checks/duplicates';
import { createWrongOrderCheck, createGapCheck } from '../checks/gaps';
import { logPath, openLog } from './log';
import { runPipeline } from './pipeline';
import { reportIssues } from './report';

// ── Entry point ───────────────────────────────────────────────────────────────

export async function runDiagnose(
  pairs:    SourceFile[],
  isDryRun: boolean,
  logDir:   string | null,
): Promise<void> {
  for (const pair of pairs) {
    await diagnoseFile(pair, isDryRun, logDir);
  }
}

// ── Per-file orchestration ────────────────────────────────────────────────────

async function diagnoseFile(pair: SourceFile, isDryRun: boolean, logDir: string | null): Promise<void> {
  const outputPath = fixedOutputPath(pair.basePath);

  if (fs.existsSync(outputPath)) {
    info(`Skipped (already fixed): ${pair.basePath}`);
    return;
  }

  const label = path.relative(process.cwd(), pair.basePath);

  section(label);
  spacer();

  const cfg = getTableConfig(pair.tableName);

  info(`Table: ${pair.tableName}`);
  info(`File:  ${pair.basePath} (${fileSizeMb(pair.basePath)} MB)`);
  spacer();

  // Log always writes — default to source dir, --log overrides.
  const effectiveLogDir = logDir ?? path.dirname(pair.basePath);
  const log = openLog(logPath(effectiveLogDir, pair.basePath), pair.basePath, pair.tableName);

  // Pre-pass: resolve header from source or vault.
  const { fileChecks, messageChecks } = registerChecks(cfg.gapThresholdMs);

  const firstLine = await readFirstLineOrNull(pair.basePath);
  const ctx: CheckContext = {
    filePath:     pair.basePath,
    tableName:    pair.tableName,
    header:       null,
    timestampCol: cfg.timestampCol,
  };

  const prePassSummary = createIssueSummary();

  for (const check of fileChecks) {
    const result = check.run(firstLine, ctx);

    for (const issue of result.issues) {
      addToSummary(prePassSummary, issue);
      log.issue(issue);
    }

    if (result.recoveredHeader) {
      ctx.header = result.recoveredHeader;
    }
  }

  const sourceHasHeader = ctx.header !== null;

  if (! ctx.header) {
    ctx.header = recoverVaultHeader(pair.tableName);

    if (ctx.header) {
      info(`Header recovered from vault TABLE_HEADERS for table "${pair.tableName}".`);
    }
  }

  // Decide whether to write output.
  const fixedPath = fixedOutputPath(pair.basePath);
  const willWrite = (! isDryRun) && ctx.header !== null;

  if ((! isDryRun) && ctx.header === null) {
    warn('Cannot write fixed output: no valid header was recovered (source header malformed and table unknown to vault).');
  }

  const writer: Writer = willWrite ? createGzipWriter(fixedPath) : createNullWriter();

  if (willWrite && ctx.header) {
    writer.writeHeader(ctx.header);
  }

  // Stream + fix
  const result = await runPipeline(pair.basePath, ctx, messageChecks, sourceHasHeader, writer, log);

  if (willWrite) {
    await writer.close();
    success(`Written: ${fixedPath}`);
  }

  const allIssues = mergeSummaries(prePassSummary, result.summary);

  reportIssues(result.messageCount, result.writtenCount, allIssues, result.forcedEvictions, isDryRun);
  log.summary(result.messageCount, result.writtenCount, allIssues, isDryRun);
  log.close();

  info(`Log: ${log.path}`);
  spacer();
}

// ── Check registration ────────────────────────────────────────────────────────

function registerChecks(gapThresholdMs: number | null): {
  fileChecks:    FileCheck[];
  messageChecks: MessageCheck[];
} {
  const fileChecks: FileCheck[] = [headerCheck];

  const messageChecks: MessageCheck[] = [
    midStreamHeaderCheck,
    createDuplicateCheck(),
    createWrongOrderCheck(),
  ];

  if (gapThresholdMs !== null) {
    messageChecks.push(createGapCheck(gapThresholdMs));
  }

  return { fileChecks, messageChecks };
}

// ── Small helpers ─────────────────────────────────────────────────────────────

function recoverVaultHeader(tableName: string): Header | null {
  const cols = getVaultColumns(tableName);

  if (! cols) return null;

  try {
    return buildHeader(cols, `(vault TABLE_HEADERS for ${tableName})`);
  } catch {
    return null;
  }
}

async function readFirstLineOrNull(filePath: string): Promise<string | null> {
  try {
    return await readFirstLine(filePath);
  } catch {
    return null;
  }
}

function fixedOutputPath(basePath: string): string {
  return basePath.replace(/\.csv(\.gz)?$/, '.fixed.csv.gz');
}

function fileSizeMb(filePath: string): string {
  try {
    return (fs.statSync(filePath).size / (1024 * 1024)).toFixed(1);
  } catch {
    return '?';
  }
}

// ── Test exports ──────────────────────────────────────────────────────────────

export const _test_fixedOutputPath    = fixedOutputPath;
export const _test_taskLogPath        = logPath;
export const _test_recoverVaultHeader = recoverVaultHeader;
export { bucketKey as _test_bucketKey, sortKey as _test_sortKey, oldestKey as _test_oldestKey } from './pipeline';
