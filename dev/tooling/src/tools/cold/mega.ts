import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ActiveTransfer, QueueState } from './types';

const execFileAsync = promisify(execFile);

/**
 * Mega, as `cold` uses it.
 *
 * Owned here rather than shared: once the other commands move onto `cold`,
 * every Mega call in the repo lives in this file and nowhere else. Until then
 * `db dump` and `data sync` keep their own copies, and the duplication goes
 * away by deleting theirs rather than by hoisting this.
 */

/** Whether mega-cmd will answer at all. */
export const available = async (): Promise<boolean> => {
  try {
    await execFileAsync('mega-whoami', [], { timeout: 30_000 });

    return true;
  } catch {
    return false;
  }
};

/**
 * Hand a tar to Mega's queue and return without waiting.
 *
 * `-q` is what makes the pacing work: Mega uploads one file at a time in the
 * order it received them, so handing it several means the link is never idle
 * between our tars. `-c` creates the remote directory.
 *
 * **The destination ends in a slash.** Without it, Mega writes the file *as*
 * the directory name when that directory does not yet exist — the same trap as
 * `cp`, and silent.
 */
export const queueUpload = async (local: string, remoteDir: string): Promise<void> => {
  await execFileAsync('mega-put', ['-q', '-c', local, `${remoteDir.replace(/\/$/, '')}/`],
    { timeout: 120_000 });
};

/**
 * What the whole upload queue still has to send.
 *
 * **Deliberately not filtered to our own transfers.** There is one link and one
 * FIFO queue, so anything already queued — a trucker backup running beside this
 * one, an upload started by hand — is genuinely in front of our next tar. A
 * packer that ignored it would build tars that then sit on disk for days.
 *
 * `--summary` also sidesteps the per-transfer listing's default of showing only
 * the first ten rows, which would quietly undercount a long queue.
 */
export const queue = async (): Promise<QueueState> => {
  const empty: QueueState = { remaining: 0, total: 0, uploaded: 0, transfers: 0 };

  try {
    const { stdout } = await execFileAsync(
      'mega-transfers', ['--summary', '--only-uploads'], { timeout: 60_000 });

    return parseSummary(stdout) ?? empty;
  } catch {
    return empty;
  }
};

/**
 * The local paths Mega is already carrying, active or waiting.
 *
 * **The queue outlives us.** `mega-put -q` hands a transfer to the mega-cmd
 * server, which keeps it across restarts of this command — so a recovering run
 * finds tars that are not in cold storage yet *and* not its business to send,
 * because they are already on their way.
 *
 * Handing one over a second time is not harmful in the end: Mega recognises an
 * unchanged file and completes it instantly. But it only does so once the
 * duplicate reaches the front, and until then both copies count toward the queue
 * total that decides whether more tars get made.
 *
 * `--limit` is set past any plausible queue because the listing shows ten rows
 * by default, and a short read here would look like an empty queue.
 */
export const queuedPaths = async (): Promise<Set<string>> => {
  try {
    const { stdout } = await execFileAsync(
      'mega-transfers',
      ['--only-uploads', '--limit=100000', '--col-separator=|', '--output-cols=SOURCEPATH'],
      { timeout: 60_000, maxBuffer: 64 * 1024 * 1024 },
    );

    return new Set(
      stdout.split('\n')
        .map(line => line.trim())
        .filter(line => line.startsWith('/')),
    );
  } catch {
    // Unknown is not the same as empty, but the only thing this guards is a
    // duplicate upload, and Mega collapses those on its own.
    return new Set();
  }
};

/**
 * The transfer Mega is working on right now, or null when it is idle.
 *
 * Mega sends one file at a time, so there is only ever one of these — which is
 * why the display is a single bar rather than one per worker.
 */
export const active = async (): Promise<ActiveTransfer | null> => {
  try {
    const { stdout } = await execFileAsync(
      'mega-transfers',
      ['--only-uploads', '--limit=100000', '--col-separator=|',
        '--output-cols=SOURCEPATH,PROGRESS,STATE'],
      { timeout: 60_000, maxBuffer: 64 * 1024 * 1024 },
    );

    for (const line of stdout.split('\n')) {
      const [source, progress, state] = line.split('|');

      if (state?.trim() !== 'ACTIVE' || ! source?.startsWith('/')) continue;

      // `24.85% of    2.00 GB`
      const parsed = /([\d.]+)%\s+of\s+([\d.]+)\s*([KMGT]?B)/.exec(progress ?? '');

      if (! parsed) continue;

      return {
        /**
         * The venue and the name, matching how the log names a part.
         *
         * A tar is called `202202.p01.tar` and every venue produces one, so the
         * basename alone identifies nothing — and the block sits directly under
         * log lines that *do* say which venue, which made the two look like
         * different things.
         */
        name:    source.trim().split('/').slice(-2).join('/'),
        percent: Number(parsed[1]),
        bytes:   bytesOf(parsed[2]!, parsed[3]!),
      };
    }

    return null;
  } catch {
    return null;
  }
};

/**
 * Remove one object.
 *
 * Only ever called on an orphan a replan left behind, after its replacements are
 * confirmed in Mega and a person has said yes. `-f` suppresses the confirmation
 * mega-cmd would otherwise ask for on its own terms, not the one that matters.
 */
export const remove = async (remotePath: string): Promise<void> => {
  await execFileAsync('mega-rm', ['-f', remotePath], { timeout: 120_000 });
};

/**
 * Every object under a path, in one call.
 *
 * **Hundreds of parts, one round trip.** Asking per part is correct and costs a
 * process spawn each; a recursive listing answers the same question for a whole
 * origin at once, which is what makes it affordable to check *before* acting
 * rather than only when something already looks wrong.
 *
 * `-R` prints a `<directory>:` header and then its entries, so the current
 * directory is tracked as the output is read and each name joined to it.
 *
 * **Keyed relative to `root`**, which is what makes it comparable to the paths
 * the database holds. Those record a part's own location and not this
 * deployment's remote root, so keying the listing absolutely would mean pasting
 * the root onto every part at every lookup, in a dozen places, to undo a
 * difference neither side cares about.
 */
export const listing = async (
  root: string,
): Promise<Map<string, { bytes: number; handle: string | null }>> => {
  const found = new Map<string, { bytes: number; handle: string | null }>();

  try {
    const { stdout } = await execFileAsync(
      'mega-ls', ['-lR', '--show-handles', root],
      { timeout: 300_000, maxBuffer: 256 * 1024 * 1024 });

    let dir = root.replace(/\/$/, '');

    for (const line of stdout.split('\n')) {
      const header = /^(\/?[^\s].*):$/.exec(line.trimEnd());

      if (header) {
        // Headers may come without the leading slash; anchor them to the root.
        const at = header[1]!;

        dir = at.startsWith('/') ? at : `/${at}`;

        continue;
      }

      const fields = line.trimEnd().split(/\s+/);
      const name   = fields[fields.length - 1];

      if (! name || line.startsWith('FLAGS') || line.startsWith('d')) continue;

      const size   = /^\S+\s+\d+\s+(\d+)\s/.exec(line);
      const handle = /\s(H:\S+)\s/.exec(line);

      if (size) found.set(relativeTo(`${dir}/${name}`, root), { bytes: Number(size[1]), handle: handle?.[1] ?? null });
    }
  } catch {
    // An unreadable listing is not an empty one, but every caller treats a miss
    // as "ask Mega directly", which is the safe direction.
  }

  return found;
};

/** Drop the root the listing was taken of; anything outside it keeps its path. */
const relativeTo = (full: string, root: string): string => {
  const base = root.replace(/\/$/, '');

  return full.startsWith(`${base}/`) ? full.slice(base.length + 1) : full;
};

/**
 * The size and handle Mega holds for a file, or null when it holds none.
 *
 * Mega publishes a file only once it is complete, so presence at the right size
 * *is* the proof an upload finished — there is no partial state to guard
 * against and nothing to re-download and compare.
 *
 * The handle is recorded because it identifies the stored object independently
 * of its path: a later check can prove the database and Mega still agree on
 * *which* file this is, which a size alone cannot.
 */
export const remote = async (
  remotePath: string,
): Promise<{ bytes: number; handle: string | null } | null> => {
  try {
    const { stdout } = await execFileAsync(
      'mega-ls', ['-l', '--show-handles', remotePath], { timeout: 60_000 });

    return parseListing(stdout, remotePath.slice(remotePath.lastIndexOf('/') + 1));
  } catch {
    return null;
  }
};

// ── Internals ─────────────────────────────────────────────────────────────────

/**
 * The summary is a fixed-width table whose values contain spaces (`0.00   B`,
 * `907.37 MB`), and `--col-separator` does not apply to it. So the upload half
 * is matched as four fields rather than split on whitespace.
 *
 * `TOTAL` is the queue as it stands — active plus waiting, not counting what
 * has already finished and left — so `TOTAL - UPLOADED` is what remains.
 */
const parseSummary = (stdout: string): QueueState | null => {
  for (const line of stdout.split('\n')) {
    const match = /(\d+)\s+([\d.]+)\s*([KMGT]?B)\s+([\d.]+)\s*([KMGT]?B)\s+[\d.]+%\s*$/.exec(line);

    if (! match) continue;

    const uploaded = bytesOf(match[2]!, match[3]!);
    const total    = bytesOf(match[4]!, match[5]!);

    return { transfers: Number(match[1]), uploaded, total, remaining: Math.max(0, total - uploaded) };
  }

  return null;
};

/**
 * `----    1   4780000000 05Aug2026 22:09:10 H:7BtQjCAL 202405.p01.tar`
 *
 * Columns are `FLAGS VERS SIZE DATE TIME HANDLE NAME`, so the size is the
 * *second* number and not the first — `VERS` sits in front of it and is also
 * digits. The name is compared as a whole field rather than as a suffix, since
 * `x202405.p01.tar` ends with `202405.p01.tar`.
 */
const parseListing = (
  stdout: string,
  name:   string,
): { bytes: number; handle: string | null } | null => {
  for (const line of stdout.split('\n')) {
    const fields = line.trimEnd().split(/\s+/);

    if (fields[fields.length - 1] !== name) continue;

    const size   = /^\S+\s+\d+\s+(\d+)\s/.exec(line);
    const handle = /\s(H:\S+)\s/.exec(line);

    if (size) return { bytes: Number(size[1]), handle: handle?.[1] ?? null };
  }

  return null;
};

/**
 * **Mega's `GB` is a GiB.** A tar of 2,001,274,880 bytes on disk is reported by
 * `mega-transfers` as `1908.56 MB`, which is that figure over 1024² — so the
 * labels are decimal and the arithmetic behind them is binary.
 *
 * Reading them as decimal made the queue measure 7.4% light, which let packing
 * run further ahead than the target asked for.
 */
const UNITS: Record<string, number> = {
  B:  1,
  KB: 1024,
  MB: 1024 ** 2,
  GB: 1024 ** 3,
  TB: 1024 ** 4,
};

const bytesOf = (value: string, unit: string): number => Number(value) * (UNITS[unit] ?? 1);

// ── Test access ───────────────────────────────────────────────────────────────

export const _test_parseSummary = parseSummary;
export const _test_parseListing = parseListing;
