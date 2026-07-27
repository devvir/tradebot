import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { logger } from '@devvir/service-kit';
import config from './config';
import { download } from './download';
import type { Absence } from './types';

/**
 * A ledger of periods a venue said were missing, in a symbol's active range.
 *
 * Absence is the one answer trucker cannot verify. OKX has been observed
 * answering 404 for a URL that serves 200 seconds later — no 429, no other
 * signal, cause unknown — so "never published" and "not this time" are
 * indistinguishable in the moment, and the cursor moving past a believed
 * absence loses that period silently and for good.
 *
 * So an absence inside a symbol's active range is written here instead of being
 * forgotten. Once the backfill has nothing left to fetch, each entry is retried
 * on a widening schedule, and only after several spaced attempts is it accepted
 * as genuinely unpublished. The file is plain JSONL so it can be read, grepped
 * and kept after the fact — the record of what a venue never gave us.
 */

const LEDGER = () => join(config.dataDir, 'absences.jsonl');

/** Attempts before an absence is accepted as real. */
export const MAX_ATTEMPTS = 5;

/** Retry an entry only after this long, growing with each attempt. */
const BACKOFF_HOURS = [1, 6, 24, 72];

/**
 * Re-check periods a venue previously reported missing.
 *
 * Runs after a sweep, when there is nothing left to fetch and the venues are
 * idle. Each entry is retried on a widening schedule and only dropped once it
 * has been **absent** across several spaced attempts — a venue throttling us
 * for an hour, or a day, no longer costs the file.
 *
 * Only an `absent` outcome counts as an attempt. A `failed` one is a transport
 * or server problem and says nothing about whether the file exists, so it
 * re-queues the entry unchanged — counting it would let five bad-network
 * evenings write off a file the ledger exists to protect.
 */
export const retryAbsences = async (): Promise<void> => {
  const entries = await load();
  const due     = entries.filter(e => isDue(e));

  if (due.length === 0) return;

  logger.info({ pending: entries.length, due: due.length }, 'Re-checking reported absences');

  const keep: Absence[] = [];
  let recovered = 0;

  for (const entry of entries) {
    if (! due.includes(entry)) {
      keep.push(entry);
      continue;
    }

    const result = await download(entry.venue, entry.dataset, {
      url: entry.url, path: entry.path, date: entry.date, symbol: entry.symbol,
      period: entry.period,
    });

    if (result.status === 'downloaded' || result.status === 'skipped') {
      recovered++;
      continue;   // resolved — drop it
    }

    if (result.status === 'failed') {
      // No evidence either way — try again next round, attempts unchanged.
      keep.push({ ...entry, lastTried: new Date().toISOString() });
      continue;
    }

    const attempts = entry.attempts + 1;

    if (attempts >= MAX_ATTEMPTS) {
      logger.info({ url: entry.url, attempts }, 'Accepting absence as final');
      continue;
    }

    keep.push({ ...entry, attempts, lastTried: new Date().toISOString() });
  }

  await compact(keep);

  logger.info({ recovered, stillPending: keep.length }, 'Absence re-check complete');
};

export const record = async (absence: Absence): Promise<void> => {
  const path = LEDGER();

  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(absence)}\n`);
};

/** Every entry, with later records of the same URL superseding earlier ones. */
export const load = async (): Promise<Absence[]> => {
  const raw = await readFile(LEDGER(), 'utf8').catch(() => '');
  const byUrl = new Map<string, Absence>();

  for (const line of raw.split('\n')) {
    if (! line.trim()) continue;

    try {
      const entry = JSON.parse(line) as Absence;

      byUrl.set(entry.url, entry);
    } catch {
      logger.warn({ line: line.slice(0, 120) }, 'Skipping unreadable absence record');
    }
  }

  return [...byUrl.values()];
};

/** Rewrite the ledger, dropping resolved and exhausted entries. */
export const compact = async (entries: Absence[]): Promise<void> => {
  const path = LEDGER();
  const temp = `${path}.tmp`;

  await mkdir(dirname(path), { recursive: true });
  await writeFile(temp, entries.map(e => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : ''));
  await rename(temp, path);
};

/** Whether enough time has passed to try this entry again. */
export const isDue = (absence: Absence, now = Date.now()): boolean => {
  const hours = BACKOFF_HOURS[Math.min(absence.attempts, BACKOFF_HOURS.length - 1)]!;

  return now - Date.parse(absence.lastTried) >= hours * 60 * 60 * 1000;
};
