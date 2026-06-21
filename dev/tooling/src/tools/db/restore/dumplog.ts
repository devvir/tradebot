import fs from 'node:fs';
import type { DumpStat } from './types';

// Plan-table data row in dump.log, e.g.:
//   `instrument  2026-03  132,340,663  29.3GB`
// Four whitespace-separated tokens: collection, period label, ~documents
// (comma-grouped int), ~size (fmtBytes value + unit). The header, separators,
// and the multi-word `Total … N pairs …` line don't match this shape.
const ROW_RE  = /^(\S+)\s+(\S+)\s+([\d,]+)\s+([\d.]+)(B|KB|MB|GB)$/;
const UNIT_POW: Record<string, number> = { B: 0, KB: 1, MB: 2, GB: 3 };

// ── Exports ──────────────────────────────────────────────────────────────────

/**
 * Parse the dump step's `dump.log` into per-archive stats, keyed
 * `${collection}|${dashlessPeriod}` (e.g. `instrument|202603`) to match a
 * restore target's `collection` + `key`. The log is append-only and
 * chronological, and an archive may be re-dumped, so later entries overwrite
 * earlier ones — the map ends up holding the **last** dump of each pair.
 *
 * Missing/unreadable log → empty map; callers fall back to a generic estimate.
 */
export function parseDumpLog(logPath: string): Map<string, DumpStat> {
  const map = new Map<string, DumpStat>();

  let text: string;

  try {
    text = fs.readFileSync(logPath, 'utf8');
  } catch {
    return map;
  }

  for (const line of text.split('\n')) {
    const m = ROW_RE.exec(line);

    if (! m) continue;

    const [, collection, period, docsStr, sizeStr, unit] = m;
    const key   = `${collection}|${period!.replace(/-/g, '')}`;
    const docs  = parseInt(docsStr!.replace(/,/g, ''), 10);
    const bytes = Math.round(parseFloat(sizeStr!) * 1024 ** UNIT_POW[unit!]!);

    map.set(key, { docs, bytes });
  }

  return map;
}

/** Lookup key for a restore target's stats: `${collection}|${key}`. */
export function dumpStatKey(collection: string, key: string): string {
  return `${collection}|${key}`;
}
