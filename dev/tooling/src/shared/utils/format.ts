/**
 * A size in the unit a person would have chosen.
 *
 * `TB` is included because cold storage is already measured in hundreds of
 * gigabytes per venue and the trees it packs are heading well past a terabyte —
 * a ceiling at `GB` turns the totals that matter most into four-digit numbers.
 */
export function fmtBytes(bytes: number): string {
  if (bytes <= 0) return '0B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / Math.pow(1024, i)).toFixed(1)}${units[i]}`;
}

export function fmtUptime(startedAtSec: number): string {
  const diff = Math.floor((Date.now() / 1000) - startedAtSec);
  if (diff < 0) return '—';
  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ${diff % 60}s`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ${Math.floor((diff % 3600) / 60)}m`;
  return `${Math.floor(diff / 86400)}d ${Math.floor((diff % 86400) / 3600)}h`;
}

/**
 * Format an ISO timestamp as relative "time ago" string.
 * Handles nanosecond-precision Docker timestamps by truncating to milliseconds.
 */
export function fmtAgo(isoString: string): string {
  const normalized = isoString.replace(/(\.\d{3})\d+/, '$1');
  const t = new Date(normalized).getTime();
  if (isNaN(t)) return 'N/A';
  const diff = Math.floor((Date.now() - t) / 1000);
  if (diff < 5) return 'just now';
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}
