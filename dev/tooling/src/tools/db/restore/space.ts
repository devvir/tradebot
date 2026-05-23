import fs from 'node:fs';
import type { RestoreTarget, SpaceMode } from './types';

const REJECT_BELOW            = 1;  // ratio < 1   → reject
const DOWNLOAD_ONLY_BELOW     = 2;  // ratio < 2   → offer download-only
const WARN_BELOW              = 3;  // ratio < 3   → warn + proceed

// ── Exports ──────────────────────────────────────────────────────────────────

/** Bytes mongoget will need to pull (sum of Mega-only target sizes). */
export function neededDownloadBytes(targets: RestoreTarget[]): number {
  return targets
    .filter(t => t.mega && ! t.local)
    .reduce((sum, t) => sum + t.mega!.size, 0);
}

/**
 * Map (downloads needed, free space) to a `SpaceMode`. Pure function; the
 * caller drives the UX (prompt vs reject vs warn) off the returned mode.
 *
 * Returns `proceed` when there's nothing to download, since the multipliers
 * are only meaningful relative to download size.
 */
export function computeSpaceMode(downloadBytes: number, availableBytes: number): SpaceMode {
  if (downloadBytes === 0) return 'proceed';

  const ratio = availableBytes / downloadBytes;

  if (ratio < REJECT_BELOW)        return 'reject';
  if (ratio < DOWNLOAD_ONLY_BELOW) return 'download-only-offer';
  if (ratio < WARN_BELOW)          return 'warn-then-proceed';

  return 'proceed';
}

/**
 * Free bytes on the filesystem hosting `dirPath`. Creates the directory
 * first if it doesn't exist (statfs needs an existing path; the caller is
 * going to write into it anyway).
 */
export function getAvailableBytes(dirPath: string): number {
  fs.mkdirSync(dirPath, { recursive: true });

  const s = fs.statfsSync(dirPath);

  return Number(s.bavail) * Number(s.bsize);
}
