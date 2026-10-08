import { fileLabelOf } from '../vault/layout';
import { answering, megaCmd } from './exec';
import type { ActiveTransfer, QueueState } from '../types';

/** Whether mega-cmd will answer at all. */
export const available = answering;

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
  await megaCmd('mega-put', ['-q', '-c', local, `${remoteDir.replace(/\/$/, '')}/`],
    { timeout: 120_000 });
};

/**
 * Ask Mega to bring a stored tar back, and return without waiting.
 *
 * Queued like an upload, so it runs beside whatever else is going on: a tar
 * coming back to be corrected costs download capacity, and the link's upload
 * side stays busy with other tars meanwhile.
 */
export const queueDownload = async (remotePath: string, localDir: string): Promise<void> => {
  await megaCmd('mega-get', ['-q', remotePath, `${localDir.replace(/\/$/, '')}/`], { timeout: 120_000 });
};

/**
 * The local paths Mega is bringing files back to, active or waiting.
 *
 * As with uploads, the queue outlives this command — so a tar still on its way
 * is not asked for a second time.
 */
export const downloadingPaths = async (): Promise<Set<string>> => {
  try {
    const { stdout } = await megaCmd(
      'mega-transfers',
      ['--only-downloads', '--limit=100000', '--col-separator=|', '--output-cols=DESTINYPATH'],
      { timeout: 60_000, maxBuffer: 64 * 1024 * 1024 },
    );

    return new Set(stdout.split('\n').map(line => line.trim()).filter(line => line.startsWith('/')));
  } catch {
    return new Set();
  }
};

/**
 * What the whole upload queue still has to send.
 *
 * **Deliberately not filtered to our own transfers.** There is one link and one
 * FIFO queue, so anything already queued — another backup running beside this
 * one, an upload started by hand — is genuinely in front of our next tar. A
 * packer that ignored it would build tars that then sit on disk for days.
 *
 * `--summary` also sidesteps the per-transfer listing's default of showing only
 * the first ten rows, which would quietly undercount a long queue.
 */
export const queue = async (): Promise<QueueState> => {
  const empty: QueueState = { remaining: 0, total: 0, uploaded: 0, transfers: 0 };

  try {
    const { stdout } = await megaCmd(
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
    const { stdout } = await megaCmd(
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
 * Take out of the upload queue every transfer that is a second one of the same
 * file to the same place, below these local directories. Returns how many went.
 *
 * A file can be handed over twice: Mega is slow to show a transfer it has
 * accepted, and for a moment after one finishes it is in neither the queue nor
 * the listing. Sent twice it is stored twice, as two versions. The one already
 * being sent is kept, else the first asked for; what belongs to anything else
 * using the same queue is not looked at.
 *
 * Not a guarantee — the second may already be on its way — only tidiness.
 */
export const dropDuplicateUploads = async (under: readonly string[]): Promise<number> => {
  try {
    const { stdout } = await megaCmd(
      'mega-transfers',
      ['--only-uploads', '--limit=100000', '--col-separator=|', '--output-cols=TAG,STATE,SOURCEPATH,DESTINYPATH'],
      { timeout: 60_000, maxBuffer: 64 * 1024 * 1024 },
    );

    const extra = duplicatesIn(stdout, under);

    for (const tag of extra) await megaCmd('mega-transfers', ['-c', tag], { timeout: 60_000 });

    return extra.length;
  } catch {
    return 0;
  }
};

/** The tags of the transfers to cancel, read off the queue as `TAG|STATE|SOURCEPATH|DESTINYPATH` lines. */
const duplicatesIn = (stdout: string, under: readonly string[]): string[] => {
  const same = new Map<string, { tag: string; active: boolean }[]>();

  for (const line of stdout.split('\n')) {
    const [tag, state, source, destiny] = line.split('|').map(part => part.trim());

    if (! tag || ! /^\d+$/.test(tag) || ! source || ! under.some(dir => source.startsWith(`${dir.replace(/\/$/, '')}/`))) continue;

    same.set(`${source}|${destiny}`, [...same.get(`${source}|${destiny}`) ?? [], { tag, active: state === 'ACTIVE' }]);
  }

  return [...same.values()].flatMap((transfers) => {
    const keep = transfers.find(one => one.active) ?? transfers.sort((a, b) => Number(a.tag) - Number(b.tag))[0]!;

    return transfers.filter(one => one !== keep).map(one => one.tag);
  });
};

/**
 * The transfer Mega is working on right now, or null when it is idle.
 *
 * Mega sends one file at a time, so there is only ever one of these — which is
 * why the display is a single bar rather than one per worker.
 */
export const active = async (): Promise<ActiveTransfer | null> => {
  try {
    const { stdout } = await megaCmd(
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
         *
         * A vault file is called `<month>.parquet` and every slice has one, so
         * it is named by the partition it is of.
         */
        name:    nameOf(source.trim()),
        percent: Number(parsed[1]),
        bytes:   bytesOf(parsed[2]!, parsed[3]!),
      };
    }

    return null;
  } catch {
    return null;
  }
};

// ── Internals ─────────────────────────────────────────────────────────────────

/** What a file being sent is called on the progress line: enough of its path to say which it is. */
const nameOf = (source: string): string => {
  const vault = source.indexOf('/venue=');

  return vault < 0 ? source.split('/').slice(-2).join('/') : fileLabelOf(source.slice(vault + 1));
};

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
export const _test_duplicatesIn = duplicatesIn;
