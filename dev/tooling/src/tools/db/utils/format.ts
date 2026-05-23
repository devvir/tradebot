/** Formatting helpers shared across db subcommands. */

export function fmtNum(n: number): string {
  return n.toLocaleString('en-US');
}

export function fmtRate(perSec: number): string {
  if (perSec >= 1_000_000) return `${(perSec / 1_000_000).toFixed(1)}M`;
  if (perSec >= 1_000)     return `${(perSec / 1_000).toFixed(1)}K`;

  return perSec.toFixed(0);
}

const M = 1_000_000;
const B = 1_000_000_000;

/**
 * Compact human-readable count using M (millions) and B (billions) only — never
 * K, never raw. Always 1 decimal. Use where alignment matters more than
 * sub-million precision (e.g. live progress columns).
 *
 *   0       → "0.0M"
 *   703_157 → "0.7M"
 *   11_132_039  → "11.1M"
 *   204_716_976 → "204.7M"
 *   1_234_567_890 → "1.2B"
 *
 * Width range is 4–6 chars; right-pad to 6 for column alignment.
 */
export function fmtCount(n: number): string {
  if (n >= B) return `${(n / B).toFixed(1)}B`;

  return `${(n / M).toFixed(1)}M`;
}

export function fmtElapsed(sec: number): string {
  if (sec < 60)   return `${sec.toFixed(0)}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${Math.floor(sec % 60)}s`;

  return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
}

export function pad(s: string, width: number, align: 'left' | 'right'): string {
  return align === 'left' ? s.padEnd(width) : s.padStart(width);
}
