import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { agreed } from '../options';
import * as mega from './mega';
import { BACKEDUP, LEDGER } from './vault/ledger';
import { fmtBytes } from '../../../shared/utils/format';
import { info, warn } from '../../../shared/ui/logger';
import type { ColdConfig } from '../types';
import type { Kept, Remote, Sent } from './types';

/**
 * A copy in Mega of the files cold storage cannot be read without.
 *
 * **The record is the only thing that knows what a tar holds**, and the vault's
 * ledgers the only thing that knows what its files are. Neither is versioned
 * anywhere, and losing either leaves terabytes in Mega that nothing can name.
 * So each is copied there whenever it has changed: the record as every command
 * ends, the ledgers as a command that works on the vault does.
 *
 *     <MEGA_ROOT>/@cold/cold.sqlite
 *     <MEGA_ROOT>/@cold/vault/ledger.csv
 *     <MEGA_ROOT>/@cold/vault/backedup.csv
 *
 * **Sent as a copy, never as the file itself.** The record is being written
 * while it is read, and the ledger is appended to by whoever stocks the vault:
 * what goes to Mega is a copy taken whole, in `<cold>/backup`.
 *
 * **What was last sent is written down here**, in `<cold>/backup/sent.json`: a
 * digest and a size for each. A file is sent again when its digest is no longer
 * that one, and at no other time — sending is asked of Mega's queue and costs
 * nothing where nothing changed.
 *
 * **These files grow.** The ledgers are only ever appended to, so one that is
 * smaller than its copy by a single byte has lost something. The record grows
 * over time and dips a little along the way — a plan is redrawn, a revision
 * that was replaced is forgotten, and a copy of the same rows does not always
 * pack into the same pages — so for it the sign is losing more than
 * `MAY_SHRINK` of what its copy weighs. Either is not a change to pass on:
 * something has gone wrong here, and the copy in Mega may be the only good one.
 * It is never sent without a person saying so, and the question's own answer
 * is no.
 */

/** The record, as a file kept in Mega. */
export const recordOf = (config: ColdConfig): Kept => ({
  name:   'cold.sqlite',
  remote: '',
  shrink: MAY_SHRINK,
  copy:   (to) => {
    if (! fs.existsSync(config.dbPath)) return false;

    // Whole and consistent while others write: the record is in WAL mode, and a copy of its file alone is not the record.
    const db = new DatabaseSync(config.dbPath);

    try {
      db.exec(`VACUUM INTO '${to.replace(/'/g, "''")}'`);
    } finally {
      db.close();
    }

    return true;
  },
});

/** The vault's ledgers, as files kept in Mega. */
export const ledgersOf = (config: ColdConfig): Kept[] => [LEDGER, BACKEDUP].map(name => ({
  name,
  remote: 'vault',
  copy:   (to) => {
    const from = path.join(config.vaultRoot, name);

    if (! fs.existsSync(from)) return false;

    fs.copyFileSync(from, to);

    return true;
  },
}));

/**
 * As a command starts: is the record's copy in Mega what the record is now?
 *
 * Nothing is said where it is. Where it is not, a run before this one changed
 * the record and did not get to send it:
 *
 * - **A run that died** — it left its lock behind — is the plain case, and the
 *   copy is brought up to date without asking.
 * - **Otherwise it is asked**, and yes unless told otherwise.
 * - **A record smaller than its copy** is neither — see above.
 *
 * `orphaned` says whether a lock was found whose holder is gone.
 */
export const check = async (config: ColdConfig, orphaned: boolean, remote: Remote = mega): Promise<void> => {
  try {
    await checked(config, orphaned, remote);
  } catch (err) {
    warn(`Could not check the backup of the cold database (${(err as Error).message.split('\n')[0]})`);
  }
};

const checked = async (config: ColdConfig, orphaned: boolean, remote: Remote): Promise<void> => {
  const kept  = recordOf(config);
  const state = await stateOf(config, kept, remote);

  if (! state || state.same) return;

  try {
    await settle(config, kept, state, orphaned, remote);
  } finally {
    // Sent, it was moved into place; not sent, it is not left lying there.
    fs.rmSync(state.copy, { force: true });
  }
};

/** What is done about a record that is not what its copy is. */
const settle = async (
  config:   ColdConfig,
  kept:     Kept,
  state:    { copy: string; digest: string; bytes: number; there: number | null; shrunk: boolean },
  orphaned: boolean,
  remote:   Remote,
): Promise<void> => {

  if (state.shrunk) {
    warn(`The cold database is much SMALLER than its backup: ${lessThan(state.bytes, state.there ?? 0)}.`);
    warn('It does not shrink like that by itself, so something happened to it here — the backup may be the good one.');

    if (await agreed('Replace the backup with the smaller database?', false)) await send(config, kept, state, remote);

    return;
  }

  if (orphaned) {
    info('Backing up the cold database — an earlier run stopped before it could');

    await send(config, kept, state, remote);

    return;
  }

  if (await agreed('The backup of the cold database is out of date. Update it?', true)) await send(config, kept, state, remote);
};

/**
 * As a command ends, or a round of one that keeps running: send each of these
 * that has changed since it was last sent. Nothing is asked here, so one that
 * has shrunk is said and left.
 */
export const save = async (config: ColdConfig, kept: readonly Kept[], remote: Remote = mega): Promise<void> => {
  for (const one of kept) {
    try {
      const state = await stateOf(config, one, null);

      if (! state || state.same) continue;

      if (state.shrunk) {
        fs.rmSync(state.copy, { force: true });

        warn(`${one.name} is SMALLER than its backup: ${lessThan(state.bytes, state.there ?? 0)} — not backed up. It does not shrink by itself: look at it first.`);

        continue;
      }

      await send(config, one, state, remote);
    } catch (err) {
      // What a command was run to do is done: its copy not going is said, and is sent the next time.
      warn(`Could not back up ${one.name} (${(err as Error).message.split('\n')[0]}) — the next command tries again`);
    }
  }
};

// ── Internals ─────────────────────────────────────────────────────────────────

/**
 * How a kept file stands against what was last sent of it — and, where Mega is
 * asked, against what Mega holds. Null where there is no such file here.
 *
 * `there` is what the copy weighs: in Mega where it answered, as last sent
 * where it was not asked or did not answer, null where there is no copy.
 */
const stateOf = async (
  config: ColdConfig,
  kept:   Kept,
  remote: Remote | null,
): Promise<{ copy: string; digest: string; bytes: number; there: number | null; same: boolean; shrunk: boolean } | null> => {
  // Its own name for each run: several cold commands run side by side, and each takes its own copy.
  const copy = path.join(config.coldRoot, DIR, kept.remote, `${kept.name}.${process.pid}.new`);

  fs.mkdirSync(path.dirname(copy), { recursive: true });
  fs.rmSync(copy, { force: true });

  if (! kept.copy(copy)) return null;

  const digest = createHash('sha256').update(fs.readFileSync(copy)).digest('hex');
  const bytes  = fs.statSync(copy).size;
  const sent   = sentOf(config)[keyOf(kept)];

  let there: number | null = sent?.bytes ?? null;
  let held = true;

  if (remote && sent?.digest === digest) {
    const asked = await within(MEGA_MS, async () => ({
      listed:  await remote.listing(config.backupRoot),
      queued:  await remote.queuedPaths(),
    }));

    if (! asked) {
      warn('Mega did not answer about the backup of the cold database — going by what was last sent');
    } else if (! asked.queued.has(path.join(config.coldRoot, DIR, kept.remote, kept.name))) {
      const found = asked.listed.get(path.posix.join(kept.remote, kept.name));

      there = found?.bytes ?? null;
      held  = found?.bytes === sent.bytes;
    }
  }

  const same = sent?.digest === digest && held;

  // Not going anywhere: the copy has said what it had to.
  if (same) fs.rmSync(copy, { force: true });

  return { copy, digest, bytes, there, same, shrunk: there !== null && bytes < there * (1 - (kept.shrink ?? 0)) };
};

/** Hand a copy to Mega's queue, and write down what was sent. */
const send = async (
  config: ColdConfig,
  kept:   Kept,
  state:  { copy: string; digest: string; bytes: number },
  remote: Remote,
): Promise<void> => {
  const local = path.join(config.coldRoot, DIR, kept.remote, kept.name);

  // Renamed into place: a transfer still reading the copy before this one keeps the file it opened.
  fs.renameSync(state.copy, local);

  try {
    await remote.queueUpload(local, path.posix.join(config.backupRoot, kept.remote));
  } catch (err) {
    warn(`Could not back up ${kept.name} (${(err as Error).message.split('\n')[0]}) — the next command tries again`);

    return;
  }

  const sent: Record<string, Sent> = { ...sentOf(config), [keyOf(kept)]: { digest: state.digest, bytes: state.bytes, at: new Date().toISOString() } };

  fs.writeFileSync(path.join(config.coldRoot, DIR, SENT), `${JSON.stringify(sent, null, 2)}\n`);
};

const sentOf = (config: ColdConfig): Record<string, Sent> => {
  try {
    return JSON.parse(fs.readFileSync(path.join(config.coldRoot, DIR, SENT), 'utf8')) as Record<string, Sent>;
  } catch {
    return {};
  }
};

const keyOf = (kept: Kept): string => path.posix.join(kept.remote, kept.name);

/** What something answers with, or null where it has not answered in time or has failed. */
const within = async <T>(ms: number, ask: () => Promise<T>): Promise<T | null> => {
  let timer: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      ask(),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), ms); }),
    ]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
};

/** Two sizes and what lies between them, the difference in the unit that shows it. */
const lessThan = (here: number, there: number): string =>
  `${fmtBytes(here)} here, ${fmtBytes(there)} in Mega, ${fmtBytes(there - here)} less`;

/** How much smaller than its copy the record may be before that is taken for a loss, as a share of the copy. */
const MAY_SHRINK = 0.1;

/** Below cold's own directory: the copies, and the note of what was sent. */
const DIR  = 'backup';
const SENT = 'sent.json';

/** How long Mega is given to say what it holds before a command carries on without it. */
const MEGA_MS = 20_000;
