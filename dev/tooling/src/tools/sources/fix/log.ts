import fs from 'node:fs';
import path from 'node:path';
import { createWriteStream, type WriteStream } from 'node:fs';
import { warn } from '../../../shared/ui/logger';
import type { DiagnosticIssue, IssueSummary, IssueType } from '../checks/types';
import { FIXED_ISSUE_TYPES } from '../checks/types';

export interface DiagnosticLog {
  issue(issue: DiagnosticIssue): void;
  summary(messageCount: number, writeCount: number, summary: IssueSummary, isDryRun: boolean): void;
  close(): void;
  path: string;
}

/** Derive log file path: `<dir>/<source-basename>.log`. */
export function logPath(dir: string, sourcePath: string): string {
  const base = path.basename(sourcePath).replace(/\.csv(\.gz)?$/, '.log');

  return path.join(dir, base);
}

/** Open a real-time diagnostic log file. Falls back to a no-op log on failure. */
export function openLog(filePath: string, sourcePath: string, tableName: string): DiagnosticLog {
  let stream: WriteStream;

  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    stream = createWriteStream(filePath, { flags: 'w' });
  } catch {
    warn(`Cannot create log file: ${filePath}`);

    return nullLog(filePath);
  }

  stream.write(`File:    ${sourcePath}\n`);
  stream.write(`Table:   ${tableName}\n`);
  stream.write(`Timestamp: ${new Date().toISOString()}\n\n`);

  return {
    path: filePath,

    issue(issue: DiagnosticIssue) {
      const range = issue.firstDate ? `${issue.firstDate} → ${issue.date}` : issue.date;

      stream.write(`[${issue.type}] ${range}  ${issue.message}\n`);
    },

    summary(messageCount, writeCount, issueSummary, isDryRun) {
      stream.write('\n--- Summary ---\n');
      stream.write(`Scanned: ${messageCount.toLocaleString()} messages\n`);

      if (Object.keys(issueSummary.counts).length === 0) {
        stream.write('No issues found.\n');
      } else {
        for (const [type, count] of Object.entries(issueSummary.counts) as [IssueType, number][]) {
          const tag = FIXED_ISSUE_TYPES.has(type) ? '(fixed)' : '(warning only)';

          stream.write(`${type}: ${count.toLocaleString()}  ${tag}\n`);
        }
      }

      const verb = isDryRun ? 'Would write' : 'Written';

      stream.write(`${verb}: ${writeCount.toLocaleString()} messages\n`);
    },

    close() {
      stream.end();
    },
  };
}

function nullLog(filePath: string): DiagnosticLog {
  return {
    path:     filePath,
    issue()   { /* no-op */ },
    summary() { /* no-op */ },
    close()   { /* no-op */ },
  };
}
