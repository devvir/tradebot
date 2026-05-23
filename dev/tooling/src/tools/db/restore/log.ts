import fs from 'node:fs';
import path from 'node:path';
import { warn } from '../../../shared/ui/logger';
import { fmtBytes } from '../../../shared/utils/format';
import type { RestoreTarget, RestoreOutcome } from './types';

const LOG_FILENAME = 'restore.log';

// ── Exports ──────────────────────────────────────────────────────────────────

/**
 * Append a single entry to `<outDir>/restore.log` capturing the resolved
 * targets and the per-target outcomes (docs restored, durations, failures).
 * Called once per confirmed run, after execution completes.
 */
export function appendRestoreLog(
  outDir:   string,
  args:     string[],
  targets:  RestoreTarget[],
  outcomes: RestoreOutcome[],
  removed:  string[],
): void {
  const lines: string[] = [];

  lines.push('═'.repeat(72));
  lines.push(`${timestamp()}  —  restore  —  args: ${args.join(' ') || '(none)'}`);
  lines.push(`output: ${outDir}`);

  if (targets.length > 0) {
    lines.push('');
    lines.push(`targets (${targets.length}):`);

    for (const t of targets) {
      const where = [t.local && 'local', t.mega && 'mega'].filter(Boolean).join(' + ');
      const size  = fmtBytes(t.local?.size ?? t.mega?.size ?? 0);

      lines.push(`  ${t.collection}/${t.filename}  (${where}, ${size})`);
    }
  }

  if (outcomes.length > 0) {
    let ok   = 0;
    let fail = 0;

    lines.push('');
    lines.push('results:');

    for (const o of outcomes) {
      if (o.error) {
        lines.push(`  ✗ ${o.collection}/${o.key}  FAILED: ${o.error}`);
        fail++;
      } else {
        const seconds = (o.elapsedMs / 1000).toFixed(1);

        lines.push(`  ✓ ${o.collection}/${o.key}  ${o.documents ?? 0} docs in ${seconds}s`);
        ok++;
      }
    }

    lines.push(`  total: ${ok} ok, ${fail} failed`);
  }

  if (removed.length > 0) {
    lines.push('');
    lines.push(`removed from local (${removed.length}):`);
    for (const p of removed) lines.push(`  ${p}`);
  }

  lines.push('');

  try {
    fs.mkdirSync(outDir, { recursive: true });
    fs.appendFileSync(path.join(outDir, LOG_FILENAME), lines.join('\n') + '\n');
  } catch (err) {
    warn(`Could not write restore.log: ${(err as Error).message}`);
  }
}

// ── Internals ────────────────────────────────────────────────────────────────

function timestamp(): string {
  return new Date().toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, 'Z');
}
