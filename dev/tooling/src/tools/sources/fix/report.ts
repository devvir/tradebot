import { info, warn, success, spacer } from '../../../shared/ui/logger';
import type { IssueSummary, IssueType } from '../checks/types';
import { FIXED_ISSUE_TYPES } from '../checks/types';

export function reportIssues(
  messageCount:    number,
  writeCount:      number,
  summary:         IssueSummary,
  forcedEvictions: number,
  isDryRun:        boolean,
): void {
  info(`Messages scanned: ${messageCount.toLocaleString()}`);

  if (Object.keys(summary.counts).length === 0 && forcedEvictions === 0) {
    success('No issues found.');

    return;
  }

  for (const [type, count] of Object.entries(summary.counts) as [IssueType, number][]) {
    const fixable = FIXED_ISSUE_TYPES.has(type);
    const tag     = fixable ? '(fixed)' : '(warning only)';

    warn(`${type}: ${count.toLocaleString()}  ${tag}`);
  }

  if (Object.keys(summary.samples).length > 0) {
    spacer();
    info('Sample issues:');

    for (const [type, samples] of Object.entries(summary.samples) as [IssueType, NonNullable<IssueSummary['samples'][IssueType]>][]) {
      for (const s of samples) {
        const range = s.firstDate ? `${s.firstDate} → ${s.date}` : s.date;

        info(`  [${type}] ${range}  ${s.message}`);
      }
    }
  }

  if (forcedEvictions > 0) {
    spacer();
    warn(`Memory-pressure evictions: ${forcedEvictions.toLocaleString()} — dedup window was narrowed during a burst; re-run the fix on the output to re-sort and catch remaining duplicates.`);
  }

  spacer();

  if (isDryRun) {
    info(`Would write: ${writeCount.toLocaleString()} messages (after removing fixable issues and sorting)`);
  } else {
    success(`Written: ${writeCount.toLocaleString()} messages`);
  }
}
