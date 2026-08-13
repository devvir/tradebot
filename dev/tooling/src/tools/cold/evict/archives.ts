import fs from 'node:fs';
import path from 'node:path';
import { monthOf } from '../planners/archives';
import { idOf, inputsByRaw, openFacts } from '../ledger';
import { reclaim } from './reclaim';
import { fmtBytes } from '../../../shared/utils/format';
import { C } from '../../../shared/utils/colors';
import * as db from '../db';
import { info, spacer, warn } from '../../../shared/ui/logger';
import { confirm } from '../../../shared/ui/prompts';
import type { DatabaseSync } from 'node:sqlite';
import type { FactManager } from '@tradebot/pipeline';
import { EVICT_CAUSES } from '../types';
import type { ColdConfig, EvictCause, EvictGroup, EvictMonth } from '../types';

/**
 * Reclaim raw a venue-month at a time, once nothing depends on it locally.
 *
 * Two questions, and they are not the same question:
 *
 * - **Is it safe to delete?** The raw is in Mega, and what is in Mega is exactly
 *   what is on disk. Answered entirely from `cold.sqlite`, and it is what makes
 *   the deletion recoverable.
 * - **Is it finished with?** Every file reached a partition, and that partition
 *   is itself in Mega. Answered from what stocker says it built, joined to the
 *   vault side of cold storage.
 *
 * The second is not about safety — a file backed up as raw can be deleted with
 * nothing lost either way. It is about **alignment**: raw exists to become
 * parquet, so raw that never became any is either something trucker should stop
 * collecting or something stocker should be modelling. Evicting it would settle
 * that by forgetting it. Blocking says so out loud instead, which is how gate's
 * unmodelled spot klines were found.
 *
 * **Only the archives ask the second question.** The vault has no downstream to
 * be aligned with — a partition is the end of the line — so `evict vault` asks
 * the first alone. See [vault.ts](vault.ts).
 */
export const evictArchives = async (
  handle: DatabaseSync,
  config: ColdConfig,
  venues: string[],
  purge:  boolean,
): Promise<void> => {
  const wanted = venues.length > 0 ? venues : db.venues(handle, 'archives');

  if (wanted.length === 0) {
    info('Nothing from archives is in cold storage yet — nothing can be evicted');

    return;
  }

  const months: EvictMonth[] = [];
  const facts  = openFacts(config);

  try {
    for (const venue of wanted.sort())
      months.push(...await examine(handle, config, facts, venue));
  } finally {
    facts.close();
  }

  await act(handle, config, months, purge);
};

// ── Internals ─────────────────────────────────────────────────────────────────

/**
 * Judge every month of one venue.
 *
 * Per venue rather than all at once because the sets are large — 2.5 million
 * archive members and stocker's members to match them against — and a venue is
 * the unit a person asks about anyway.
 */
const examine = async (
  handle: DatabaseSync,
  config: ColdConfig,
  facts:  FactManager,
  venue:  string,
): Promise<EvictMonth[]> => {
  info(`Examining ${venue} …`);

  const unsent = db.unsentMonths(handle, 'archives');

  /** What Mega holds for this venue, as it was when packed. */
  const cold = new Map<string, Map<string, { bytes: number; mtime: number }>>();

  for (const row of db.uploaded(handle, 'archives', venue)) {
    const month = cold.get(row.month) ?? new Map();

    month.set(row.path, { bytes: Number(row.bytes), mtime: Number(row.mtime) });
    cold.set(row.month, month);
  }

  const local    = await onDisk(config.sourceRoot, venue);
  const built    = inputsByRaw(facts, venue);
  const backedUp = vaultIds(handle, config, venue);

  const months: EvictMonth[] = [];

  for (const month of [...cold.keys()].sort()) {
    if (unsent.has(`${venue}/${month}`)) {
      months.push({ venue, month, verdict: 'blocked', files: [], bytes: 0,
        reasons: ['a part of this month is not in Mega yet'], causes: ['unsent'] });

      continue;
    }

    months.push(judge(venue, month, cold.get(month)!, local.get(month) ?? new Map(), built, backedUp));
  }

  return months;
};

/**
 * Compare one month four ways.
 *
 * **Extra or changed blocks; missing only warns.** A file on disk that Mega has
 * never seen would be destroyed by deleting it, and a file whose size or mtime
 * has moved means the copy in Mega is of something else — both are reasons to
 * stop. A file Mega holds and disk no longer does costs nothing to proceed on:
 * there is nothing there to lose. It still gets said, because it means somebody
 * or something removed raw outside this command.
 *
 * **Unless nothing is left at all, which is this command's own finished work.**
 * A month evicted last week has every file recorded in cold storage and none of
 * them on disk — that is not a discrepancy to warn about, it is the end state
 * the whole family aims at. Counting it as a candidate offers a deletion that
 * can only ever free zero bytes, and every month ever evicted joins that offer
 * permanently, until the real answer is buried under months that are already
 * done.
 */
const judge = (
  venue:    string,
  month:    string,
  cold:     Map<string, { bytes: number; mtime: number }>,
  local:    Map<string, { bytes: number; mtime: number }>,
  built:    Map<string, string[]>,
  backedUp: Set<string>,
): EvictMonth => {
  // Nothing on disk: already reclaimed, and there is nothing left to decide.
  if (local.size === 0)
    return { venue, month, verdict: 'reclaimed', files: [], bytes: 0, reasons: [], causes: [] };

  const extra:   string[] = [];
  const changed: string[] = [];
  const unbuilt: string[] = [];
  const stale:   string[] = [];

  for (const [file, now] of local) {
    const was = cold.get(file);

    if (! was) { extra.push(file); continue; }

    if (was.bytes !== now.bytes || was.mtime !== now.mtime) changed.push(file);

    const ids = built.get(file);

    if (! ids || ids.length === 0) unbuilt.push(file);
    else if (! ids.every(id => backedUp.has(id))) stale.push(file);
  }

  const missing = [...cold.keys()].filter(file => ! local.has(file));
  const reasons: string[] = [];
  const causes:  EvictCause[] = [];

  if (extra.length)   { causes.push('extra');   reasons.push(`${extra.length} on disk that Mega has never seen (e.g. ${extra[0]})`); }
  if (changed.length) { causes.push('changed'); reasons.push(`${changed.length} changed since they were packed (e.g. ${changed[0]})`); }
  if (unbuilt.length) { causes.push('unbuilt'); reasons.push(`${unbuilt.length} that never reached the vault (e.g. ${unbuilt[0]})`); }
  if (stale.length)   { causes.push('stale');   reasons.push(`${stale.length} whose partition is not in Mega yet (e.g. ${stale[0]})`); }

  const files = [...local.keys()];
  const bytes = [...local.values()].reduce((total, file) => total + file.bytes, 0);

  if (reasons.length > 0) return { venue, month, verdict: 'blocked', files: [], bytes: 0, reasons, causes };

  if (missing.length > 0)
    return { venue, month, verdict: 'risky', files, bytes, causes,
      reasons: [`${missing.length} of ${cold.size} already gone from disk`] };

  return { venue, month, verdict: 'clear', files, bytes, reasons: [], causes };
};

/**
 * Every raw file of a venue on disk now, by month.
 *
 * The month comes from the path, exactly as the packer read it — anything else
 * would file a file under one month here and another there.
 */
const onDisk = async (
  sourceRoot: string,
  venue:      string,
): Promise<Map<string, Map<string, { bytes: number; mtime: number }>>> => {
  const found = new Map<string, Map<string, { bytes: number; mtime: number }>>();
  const stack = [path.join(sourceRoot, venue)];

  let seen = 0;

  while (stack.length > 0) {
    const dir = stack.pop()!;

    let entries: fs.Dirent[] = [];

    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.name === '@meta') continue;

      const absolute = `${dir}/${entry.name}`;

      if (entry.isDirectory()) { stack.push(absolute); continue; }
      if (! entry.isFile()) continue;

      const relative = absolute.slice(sourceRoot.length + 1);
      const month    = monthOf(relative);

      if (! month) continue;

      const stat  = fs.statSync(absolute);
      const bucket = found.get(month) ?? new Map();

      bucket.set(relative, { bytes: stat.size, mtime: Math.floor(stat.mtimeMs) });
      found.set(month, bucket);

      if (++seen % BREATH === 0) await breathe();
    }
  }

  return found;
};

/**
 * Hand the event loop back for one tick.
 *
 * **This is what makes Ctrl-C work.** Node delivers a signal through the event
 * loop, so a handler cannot run while a synchronous run holds the stack — and
 * examining a venue is a quarter of a million `stat` calls and a megabyte of
 * JSON, ten seconds of it per venue with no natural await. The signal is not
 * lost, it is queued behind work that has to finish first, which reads exactly
 * like a command ignoring it.
 *
 * Yielding by count rather than by clock because the loops are uniform: the
 * cost of a tick is microseconds against thousands of `stat`s, so this is far
 * below measurable and there is nothing to tune.
 */
const BREATH = 2_000;

const breathe = (): Promise<void> => new Promise(resolve => { setImmediate(resolve); });

/**
 * The partition ids whose parquet is in Mega, rebuilt from the vault's own
 * members.
 *
 * `member` records a partition's attributes rather than stocker's id, so the id
 * is reassembled from them by [`idOf`](../ledger.ts) — cheaper and steadier than
 * rebuilding a vault *path*, which would mean copying stocker's layout rules
 * into this command.
 *
 * **A partition Mega holds an older copy of does not count.** Stocker rewrites a
 * partition in place when its inputs change, so what is backed up can be a
 * thinner version of what is on disk — and the raw this command is about to
 * delete is what the *current* one was built from. The record says the id is in
 * cold storage and it is right; it is simply answering a weaker question than
 * the one being asked here.
 *
 * The comparison is the one `cold push vault` already makes to decide what to
 * repack, so a drifted partition blocks its month until that push has run and
 * eviction stops depending on the order somebody happened to run things in.
 */
const vaultIds = (handle: DatabaseSync, config: ColdConfig, venue: string): Set<string> => {
  const ids = new Set<string>();

  for (const row of db.uploaded(handle, 'vault', venue)) {
    const now = statOf(config.vaultRoot, row.path);

    // Gone locally is not drift: the partition was evicted after being backed
    // up, which is the steady state this whole family is aiming at.
    if (now && (now.bytes !== Number(row.bytes) || now.mtime !== Number(row.mtime))) continue;

    ids.add(idOf(row));
  }

  return ids;
};

/**
 * Size and mtime of a vault file, or null when there is nothing to compare —
 * the partition was evicted, or the row names no path at all.
 *
 * The join is inside the guard because an absent path is one of the answers,
 * not a precondition: `path.join` rejects `undefined` before any `stat` could.
 */
const statOf = (root: string, relative: string): { bytes: number; mtime: number } | null => {
  try {
    const stat = fs.statSync(path.join(root, relative));

    return { bytes: stat.size, mtime: Math.floor(stat.mtimeMs) };
  } catch {
    return null;
  }
};

/**
 * Report what can go, ask, and delete what was agreed.
 *
 * **Every month is named, however many there are.** This is the one irreversible
 * command in the family, and a summary that fits on a screen is worth less here
 * than a list somebody can actually check before answering — a range hides which
 * months are inside it, and the trash catching a mistake afterwards is not a
 * reason to make the mistake easy. Grouped by venue, because that is how a
 * person holds the question.
 *
 * **A blocked month is counted, never explained.** Raw that is not open for
 * eviction yet is the ordinary state of raw — still being collected, not
 * normalised yet, its partition not backed up — and none of that is a fault to
 * report. Naming each one turned an answer about what can be reclaimed into a
 * page of warnings about what cannot, which is the wrong half to print and
 * teaches the reader to skip the part that matters.
 *
 * Where a real discrepancy hides among them, [`cold audit`](COLD-AUDIT.md) is
 * where it surfaces, and the size of the tree is the other tell.
 */
const act = async (
  handle: DatabaseSync,
  config: ColdConfig,
  months: EvictMonth[],
  purge:  boolean,
): Promise<void> => {
  const clear     = months.filter(month => month.verdict === 'clear');
  const risky     = months.filter(month => month.verdict === 'risky');
  const blocked   = months.filter(month => month.verdict === 'blocked');
  const reclaimed = months.filter(month => month.verdict === 'reclaimed');

  const freeable = (rows: EvictMonth[]): string =>
    fmtBytes(rows.reduce((total, row) => total + row.bytes, 0));

  spacer();
  reclaimable(clear);

  if (risky.length > 0)
    info(`${risky.length} month${risky.length === 1 ? '' : 's'} evictable with a caveat · ${freeable(risky)}`);

  /**
   * One dim line, and never a prompt. These are months eviction already
   * finished, so the only question they can answer is "why is the total
   * smaller than I remember" — worth a number, worth nothing more.
   */
  if (reclaimed.length > 0)
    info(`${C.dim}${reclaimed.length} month${reclaimed.length === 1 ? '' : 's'} already reclaimed${C.reset}`);

  if (blocked.length > 0) {
    info(`${C.dim}${blocked.length} month${blocked.length === 1 ? '' : 's'} not open for eviction yet${C.reset}`);

    /**
     * **Counted per cause, still not per month.** A bare count cannot separate
     * "there is nothing to do" from "the vault is behind", which are the two
     * situations somebody asking this question is actually choosing between —
     * and one of them has an action attached. A month blocked several ways is
     * counted under each, since fixing one of them does not release it.
     */
    const tally = new Map<EvictCause, number>();

    for (const month of blocked)
      for (const cause of month.causes) tally.set(cause, (tally.get(cause) ?? 0) + 1);

    for (const [cause, count] of [...tally].sort((a, b) => b[1] - a[1]))
      info(`${C.dim}    ${String(count).padStart(5)}  ${EVICT_CAUSES[cause]}${C.reset}`);
  }

  spacer();

  const going: EvictMonth[] = [];

  if (clear.length > 0 && await confirm(`${purge ? 'Delete' : 'Trash'} ${clear.length} clear month${clear.length === 1 ? '' : 's'} from the raw tree?`, false))
    going.push(...clear);

  /**
   * Asked separately, and defaulting to no.
   *
   * These months are safe by every check that protects data — what they are
   * missing is *already* missing. But something removed raw outside this
   * command, and agreeing to that should be a second decision rather than a
   * consequence of the first.
   *
   * **A second prompt has to be worth stopping for.** It only appears when part
   * of a month survives and the rest has vanished, which is genuinely odd and
   * genuinely frees space. A month with nothing left never reaches here, so the
   * question is never asked about bytes that do not exist.
   */
  if (risky.length > 0) {
    spacer();

    for (const month of risky) warn(`${month.venue}/${month.month} — ${month.reasons.join('; ')}`);

    spacer();

    if (await confirm(`Also delete what is left of ${risky.length} month${risky.length === 1 ? '' : 's'} whose raw is partly gone · ${freeable(risky)}? (at your own risk)`, false))
      going.push(...risky);
  }

  if (going.length === 0) {
    info('Nothing deleted');

    return;
  }

  const groups: EvictGroup[] = going.map(month => ({
    label: `${month.venue}/${month.month}`,
    files: month.files,
    bytes: month.bytes,
    venue: month.venue,
    month: month.month,
  }));

  const gone = await reclaim(config.sourceRoot, groups, purge);

  /**
   * **One row per part, each carrying its own totals.** Archives are evicted a
   * whole month at a time, so every part of the month goes whole — and a part
   * already knows the size and count of its members, so a month of hundreds of
   * thousands of files reduces to a handful of rows that need no join to be
   * summed.
   *
   * Recorded after the deletion and only for what actually went, so nothing is
   * ever marked gone while it is still on disk.
   */
  const rows = db.evictParts(handle, 'archives',
    gone.map(group => ({ venue: group.venue!, month: group.month! })));

  if (rows > 0) info(`${C.dim}${rows} part${rows === 1 ? '' : 's'} recorded as evicted${C.reset}`);
};

/**
 * What is clear to go, a venue at a time.
 *
 * Per venue rather than per month because eviction is decided in one answer and
 * a hundred month lines cannot be read before giving it. The range says which
 * end of the archive is being reclaimed, which is the part worth checking before
 * saying yes.
 */
const reclaimable = (clear: EvictMonth[]): void => {
  if (clear.length === 0) {
    info('Nothing is clear to evict');

    return;
  }

  const venues = new Map<string, EvictMonth[]>();

  for (const month of clear) venues.set(month.venue, [...venues.get(month.venue) ?? [], month]);

  const files = clear.reduce((total, month) => total + month.files.length, 0);
  const bytes = clear.reduce((total, month) => total + month.bytes, 0);

  for (const [venue, months] of [...venues].sort()) {
    const sorted = [...months].sort((a, b) => a.month.localeCompare(b.month));
    const total  = sorted.reduce((sum, month) => sum + month.bytes, 0);
    const count  = sorted.reduce((sum, month) => sum + month.files.length, 0);

    spacer();
    info(`${venue} — ${sorted.length} month${sorted.length === 1 ? '' : 's'} · `
      + `${count.toLocaleString()} files · ${fmtBytes(total)}`);

    for (const month of sorted)
      info(`${C.dim}    ${month.month}   ${month.files.length.toLocaleString().padStart(11)} files   `
        + `${fmtBytes(month.bytes).padStart(10)}${C.reset}`);
  }

  spacer();
  info(`${clear.length} month${clear.length === 1 ? '' : 's'} clear · `
    + `${files.toLocaleString()} files · ${fmtBytes(bytes)}`);
};

// ── Test access ───────────────────────────────────────────────────────────────

export const _test_judge    = judge;
export const _test_vaultIds = vaultIds;
