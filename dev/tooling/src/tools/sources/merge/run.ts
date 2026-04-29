import fs from 'node:fs';
import path from 'node:path';
import { confirmYNA } from '../../../shared/ui/prompts';
import { info, warn, error, success, section, spacer } from '../../../shared/ui/logger';
import type { FileGroup, Message } from '../types';
import { getTableConfig } from '../config';
import { buildHeader } from '../headers';
import { readFirstLine, streamMessages } from '../reader';
import { createGzipWriter } from '../writer';
import { mergeTable } from './algorithm';
import { collectLeafFolders, discoverGroups } from './discover';
import type { DiscoveryResult } from './discover';

// ── Entry point ───────────────────────────────────────────────────────────────

export async function runMerge(
  folder:   string,
  isDryRun: boolean,
  logDir:   string | null,
  fromDay:  string | null,
  yesAll:   boolean,
): Promise<void> {
  if (! fs.existsSync(folder)) {
    error(`Folder does not exist: ${folder}`);
    process.exit(1);
  }

  const leafFolders = collectLeafFolders(folder);

  if (leafFolders.length === 0) {
    warn(`No .csv.gz files found under: ${folder}`);
    return;
  }

  if (isDryRun) {
    section('Dry-run plan');
    spacer();
  }

  if (fromDay) {
    info(`From: ${fromDay} (days before this are skipped)`);
    spacer();
  }

  const multiFolder = leafFolders.length > 1;
  let totalToMerge  = 0;
  let acceptAll     = yesAll;

  for (const leaf of leafFolders) {
    const discovery = discoverGroups(leaf, fromDay ?? undefined);

    // In multi-folder mode, show a section label when the leaf has anything to report.
    const hasContent =
      discovery.tmpFiles.length    > 0 ||
      discovery.alreadyMerged.length > 0 ||
      discovery.singletons.length  > 0 ||
      discovery.toMerge.length     > 0;

    if (multiFolder && hasContent) {
      section(leaf);
      spacer();
    }

    printFolderDetail(discovery, isDryRun);
    totalToMerge += discovery.toMerge.length;

    if (! isDryRun) {
      // Crash recovery: delete leftover .tmp files from a previous interrupted run.
      for (const tmpFile of discovery.tmpFiles) {
        try {
          fs.unlinkSync(tmpFile);
          info(`Deleted crash file: ${tmpFile}`);
        } catch {
          warn(`Could not delete crash file: ${tmpFile}`);
        }
      }

      for (const group of discovery.toMerge) {
        section(group.day);
        spacer();

        if (! acceptAll) {
          const choice = await confirmYNA(
            `Merge ${group.paths.length} files → ${path.basename(group.outputPath)}?`,
          );

          if (choice === 'all') {
            acceptAll = true;
          } else if (choice === 'no') {
            info('Skipped.');
            spacer();
            continue;
          }
        }

        await processGroup(group, logDir);
      }
    }
  }

  if (! isDryRun && totalToMerge === 0) {
    warn('No groups to merge.');
  }
}

// ── Discovery summary ─────────────────────────────────────────────────────────

/** Print the per-folder detail lines (no global header). */
function printFolderDetail(discovery: DiscoveryResult, isDryRun: boolean): void {
  if (discovery.tmpFiles.length > 0) {
    info('Crash files to delete on startup:');

    for (const f of discovery.tmpFiles) {
      info(`  ${f}`);
    }

    spacer();
  }

  if (discovery.alreadyMerged.length > 0) {
    const n = discovery.alreadyMerged.length;

    info(`${n} day${n !== 1 ? 's' : ''} already merged — skipped.`);
    spacer();
  }

  if (discovery.singletons.length > 0) {
    const n = discovery.singletons.length;

    info(`${n} day${n !== 1 ? 's' : ''} skipped — single file, nothing to merge.`);
    spacer();
  }

  if (discovery.toMerge.length === 0) {
    return;
  }

  const verb = isDryRun ? 'Would merge' : 'To merge';

  info(`${verb} (${discovery.toMerge.length} group${discovery.toMerge.length !== 1 ? 's' : ''}):`);

  for (const group of discovery.toMerge) {
    info(`  ${group.day}:`);

    for (const p of group.paths) {
      info(`    ${p}`);
    }

    info(`    → ${group.outputPath}`);
  }

  spacer();
}

// ── Per-group processing ──────────────────────────────────────────────────────

async function processGroup(group: FileGroup, logDir: string | null): Promise<void> {

  let result: { written: number; warnings: string[]; sourceCounts: number[] };

  try {
    result = await executeGroup(group);
  } catch (err) {
    error((err as Error).message);
    process.exit(1);
  }

  if (result.warnings.length > 0) {
    for (const w of result.warnings) {
      warn(w);
    }

    spacer();
  }

  success(`Written: ${result.written.toLocaleString()} messages → ${group.outputPath}`);

  for (let i = 0; i < group.paths.length; i++) {
    const count = result.sourceCounts[i] ?? 0;
    const pct   = result.written > 0 ? Math.round(count / result.written * 100) : 0;

    info(`  ${path.basename(group.paths[i]!)}: ${count.toLocaleString()} (${pct}%)`);
  }

  spacer();

  writeGroupLog(logDir ?? path.dirname(group.outputPath), group, result, result.warnings);
}

async function executeGroup(
  group: FileGroup,
): Promise<{ written: number; warnings: string[]; sourceCounts: number[] }> {
  const cfg = getTableConfig(group.tableName);

  // Pre-validate: every file must start with a valid header row.
  const firstLine = await validateMergeHeader(group.paths[0]!);

  for (const p of group.paths.slice(1)) {
    await validateMergeHeader(p);
  }

  const baseColumns = firstLine.split(',').map(c => c.trim());
  const baseHeader  = buildHeader(baseColumns, group.paths[0]!);

  if (cfg.timestampCol && ! baseHeader.hasTimestamp) {
    throw new Error(
      `${group.paths[0]}: expected a "${cfg.timestampCol}" column for table "${group.tableName}" ` +
      `but it was not found in the header.`,
    );
  }

  // Write to a .tmp path first; rename to final on success (crash safety).
  const tmpPath = group.outputPath + '.tmp';
  const writer  = createGzipWriter(tmpPath);

  writer.writeHeader(baseHeader);

  const streams = group.paths.map(p => streamMessages(p, true) as AsyncIterable<Message>);

  const result = await mergeTable(streams, writer.writeMessage.bind(writer), {
    timestampCol: cfg.timestampCol,
    fileLabels:   group.paths,
  });

  await writer.close();

  fs.renameSync(tmpPath, group.outputPath);

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

// ── Log writing ───────────────────────────────────────────────────────────────

function writeGroupLog(
  logDir:   string,
  group:    FileGroup,
  result:   { written: number; sourceCounts: number[] },
  warnings: string[],
): void {
  const logPath = path.join(logDir, `${group.day}.log`);

  try {
    fs.mkdirSync(logDir, { recursive: true });
  } catch {
    warn(`Cannot create log directory: ${logDir}`);
    return;
  }

  const lines: string[] = [
    `Day:    ${group.day}`,
    `Table:  ${group.tableName}`,
    `Output: ${group.outputPath}`,
    '',
    'Sources:',
    ...group.paths.map((p, i) => {
      const count = result.sourceCounts[i] ?? 0;
      const pct   = result.written > 0 ? Math.round(count / result.written * 100) : 0;

      return `  ${p}  (${count.toLocaleString()} messages, ${pct}%)`;
    }),
    '',
  ];

  if (warnings.length > 0) {
    lines.push('Warnings:');

    for (const w of warnings) {
      lines.push(`  ${w}`);
    }

    lines.push('');
  }

  lines.push(`Written: ${result.written.toLocaleString()} messages`);

  try {
    fs.writeFileSync(logPath, lines.join('\n') + '\n');
    info(`Log: ${logPath}`);
  } catch {
    warn(`Failed to write merge log: ${logPath}`);
  }
}

// ── Test exports ──────────────────────────────────────────────────────────────

export const _test_executeGroup = executeGroup;
