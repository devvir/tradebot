import type { MessageCheck, DiagnosticIssue } from './types';

/**
 * Detect out-of-order messages using the per-table timestamp column
 * (falls back to `_date_` when the timestamp column is absent).
 *
 * Emits at most one `wrong-order` issue per message. The duplicate check
 * already explains most out-of-order cases, so when a duplicate fires we
 * expect this check to be silent — callers suppress wrong-order for
 * messages that duplicates already flagged.
 */
export function createWrongOrderCheck(): MessageCheck {
  let last: string | null = null;

  return {
    kind: 'message',
    name: 'wrong-order',

    onMessage(msg, ctx): DiagnosticIssue[] {
      const ts = pickTimestamp(msg, ctx.timestampCol);

      if (! ts) {
        return [];
      }

      const issues: DiagnosticIssue[] = [];

      if (last !== null && ts < last) {
        issues.push({
          type:    'wrong-order',
          message: `timestamp ${ts} < previous ${last}`,
          date:    msg.date,
        });
      } else {
        last = ts;
      }

      return issues;
    },
  };
}

/**
 * Detect forward jumps in the canonical time field larger than a given threshold.
 *
 * Only registered for tables with a `gapThresholdMs` in their config.
 * Canonical field = `timestamp` when configured, falling back to `_date_`
 * when the column is absent or the value is empty.
 */
const GAP_THRESHOLD_MS = 1000;

export function createGapCheck(thresholdMs: number): MessageCheck {
  let lastMs: number | null = null;

  return {
    kind: 'message',
    name: 'gaps',

    onMessage(msg, ctx): DiagnosticIssue[] {
      const value = pickTimestamp(msg, ctx.timestampCol);
      const ms    = Date.parse(value);

      if (Number.isNaN(ms)) {
        return [];
      }

      const issues: DiagnosticIssue[] = [];

      if (lastMs !== null) {
        const delta = ms - lastMs;

        if (delta > thresholdMs) {
          const suffix = msg.action === 'partial' ? ' (resumes with partial)' : '';

          issues.push({
            type:    'gap',
            message: `gap of ${delta} ms since previous message${suffix}`,
            date:    msg.date,
          });
        }
      }

      // Only advance the frontier — never go backward. A backwards timestamp
      // (wrong-order message) must not reset lastMs, or the next forward message
      // would show a false gap equal to the entire backwards span.
      if (lastMs === null || ms > lastMs) {
        lastMs = ms;
      }

      return issues;
    },
  };
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Pick the per-message timestamp value. Falls back to `_date_` when the
 * timestamp column is not configured or not present in the message.
 */
function pickTimestamp(msg: { date: string; timestamp: string }, timestampCol: string | null): string {
  if (timestampCol && msg.timestamp) {
    return msg.timestamp;
  }

  return msg.date;
}

// ── Test exports ──────────────────────────────────────────────────────────────

export const _test_pickTimestamp = pickTimestamp;
export const _test_GAP_THRESHOLD_MS = GAP_THRESHOLD_MS;
