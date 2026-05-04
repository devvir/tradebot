import { writeBucketLog } from '../../log';
import type { GroupLogData, PrepareGroup } from '../types';

const ISSUE_SAMPLE_LIMIT = 50;

export function writeGroupLog(group: PrepareGroup, log: GroupLogData): string | null {
  const lines: string[] = [
    `Day:    ${group.day}`,
    `Table:  ${group.tableName}`,
    `Folder: ${group.folder}`,
    '',
    'Sources:',
    ...group.paths.map(p => `  ${p}`),
    '',
  ];

  if (log.error) {
    lines.push(`FAILED: ${log.error}`, '');
  }

  lines.push(
    `Written:     ${log.written.toLocaleString()}`,
    `Dedup drops: ${log.dedupDrops.toLocaleString()}`,
  );

  if (log.overflowByDay.size > 0) {
    lines.push('', 'Overflow:');

    for (const [day, count] of log.overflowByDay) {
      lines.push(`  ${day}: ${count.toLocaleString()}`);
    }
  }

  if (log.issues.length > 0) {
    lines.push('', `Validation drops (${log.issues.length}):`);

    for (const issue of log.issues.slice(0, ISSUE_SAMPLE_LIMIT)) {
      lines.push(`  [${issue.date || '(no date)'}] ${issue.reason}`);
    }

    if (log.issues.length > ISSUE_SAMPLE_LIMIT) {
      lines.push(`  … ${(log.issues.length - ISSUE_SAMPLE_LIMIT).toLocaleString()} more`);
    }
  }

  return writeBucketLog(`${group.day}.log`, group.outputDir, lines);
}
