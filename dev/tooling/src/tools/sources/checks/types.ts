import type { Header, Message } from '../types';

/**
 * A diagnostic issue produced by a check.
 *
 * `firstDate` is used for ranged issues (e.g. a duplicate spans from when the
 * original was seen to when the copy was seen); for point issues it equals `date`.
 */
export type IssueType =
  | 'missing-header'
  | 'header-in-wrong-row'
  | 'duplicate'
  | 'wrong-order'
  | 'gap';

export interface DiagnosticIssue {
  type:       IssueType;
  message:    string;
  date:       string;
  firstDate?: string;
}

/**
 * Context shared across checks for a single file.
 *
 * `header` is null only when no header could be recovered from either the
 * file itself or the vault `TABLE_HEADERS` — in that case the streaming
 * pipeline does not run and no message checks fire.
 */
export interface CheckContext {
  filePath:     string;
  tableName:    string;
  header:       Header | null;
  timestampCol: string | null;
}

/**
 * A check that runs once, pre-stream, against the file's first raw line.
 *
 * Returns any issues it found and (optionally) a recovered header for the
 * orchestrator to use as `CheckContext.header`. A null recovered header
 * signals that the orchestrator should fall back to the vault's canonical
 * `TABLE_HEADERS` for this table.
 *
 * `firstLine` is null when the file is empty.
 */
export interface FileCheck {
  kind: 'file';
  name: string;
  run(firstLine: string | null, ctx: CheckContext): {
    issues:          DiagnosticIssue[];
    recoveredHeader: Header | null;
  };
}

/**
 * A check that runs once per message during the streaming pass.
 *
 * `flush()` is called after the stream ends so checks can emit any trailing
 * issues they were still accumulating (e.g. a running duplicate range).
 */
export interface MessageCheck {
  kind: 'message';
  name: string;
  onMessage(msg: Message, ctx: CheckContext): DiagnosticIssue[];
  flush?(ctx: CheckContext): DiagnosticIssue[];
}

export type Check = FileCheck | MessageCheck;

/**
 * Issue types that are actively remediated in the output file.
 * Used to label issues as "(fixed)" vs "(warning only)" in logs and reports.
 */
export const FIXED_ISSUE_TYPES = new Set<IssueType>([
  'missing-header',      // header recovered from vault and rewritten
  'duplicate',           // row omitted from output
  'header-in-wrong-row', // row omitted from output
  'wrong-order',         // messages re-sorted in output
]);

/** Max samples retained per issue type — enough for display, no more. */
export const SAMPLE_LIMIT = 5;

/** Running counts + a handful of samples per type. Never grows with file size. */
export interface IssueSummary {
  counts:  Partial<Record<IssueType, number>>;
  samples: Partial<Record<IssueType, DiagnosticIssue[]>>;
}

export function createIssueSummary(): IssueSummary {
  return { counts: {}, samples: {} };
}

export function addToSummary(summary: IssueSummary, issue: DiagnosticIssue): void {
  summary.counts[issue.type] = (summary.counts[issue.type] ?? 0) + 1;

  const list = summary.samples[issue.type] ?? (summary.samples[issue.type] = []);

  if (list.length < SAMPLE_LIMIT) {
    list.push(issue);
  }
}

export function mergeSummaries(a: IssueSummary, b: IssueSummary): IssueSummary {
  const result = createIssueSummary();

  for (const [type, count] of Object.entries(a.counts) as [IssueType, number][]) {
    result.counts[type]  = count;
    result.samples[type] = [...(a.samples[type] ?? [])];
  }

  for (const [type, count] of Object.entries(b.counts) as [IssueType, number][]) {
    result.counts[type] = (result.counts[type] ?? 0) + count;

    const existing = result.samples[type] ?? (result.samples[type] = []);
    const toAdd    = (b.samples[type] ?? []).slice(0, SAMPLE_LIMIT - existing.length);

    existing.push(...toAdd);
  }

  return result;
}
