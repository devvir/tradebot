import fs from 'node:fs';
import path from 'node:path';
import Table from 'cli-table3';
import { loadConfig, localPath, remotePath } from './config';
import { tarSize } from './tar';
import { scanVault } from './scan';
import { idOf, idsByMonth } from './ledger';
import { fmtBytes } from '../../shared/utils/format';
import { C } from '../../shared/utils/colors';
import * as db from './db';
import * as mega from './mega';
import { info, spacer, success, warn } from '../../shared/ui/logger';
import type { DatabaseSync } from 'node:sqlite';
import type { AuditFinding, ColdConfig, Holding, Origin } from './types';

/**
 * Check that cold storage is what the record says it is.
 *
 * **Everything else in this family trusts `cold.sqlite`.** `push` decides what
 * to pack from it, `evict` decides what may be deleted from it, and neither can
 * afford to re-derive the world on every run. This is where that trust is
 * earned back: the record on one side, Mega and the local tree on the other,
 * and every place they disagree named out loud.
 *
 * **Read-only, always.** It changes nothing and repairs nothing — a report you
 * can run at any moment, against a live push if you like. What to do about a
 * finding is a decision, and decisions belong to the commands that ask first.
 *
 * The output is for a person: a short summary that fits on a screen, then the
 * problems in full. A clean run says so in one line; a broken one is meant to be
 * impossible to scroll past.
 */
export const runAudit = async (origins: Origin[]): Promise<void> => {
  /**
   * **Every tree is examined before anything is printed**, because the first
   * thing printed is now one table across all of them. A venue's vault and its
   * archives are two halves of the same question — is this venue safe — and
   * answering them in two tables a screen apart made the reader hold one set of
   * numbers in their head to compare it against the other.
   */
  const gathered: { origin: Origin; parts: ReturnType<typeof db.allParts>; findings: AuditFinding[] }[] = [];

  for (const origin of origins) {
    const config = loadConfig(origin);
    const handle = db.open(config.dbPath);

    try {
      gathered.push(await examine(handle, config, origin));
    } finally {
      db.close(handle);
    }
  }

  coverage(gathered);

  /**
   * Findings stay per origin. They name a part and not the tree it belongs to,
   * so merging them into one table would drop the only thing that says which —
   * and a heading per origin costs nothing next to that.
   */
  for (const { origin, findings } of gathered) report(origin, findings);

  reclaim(origins);

  spacer();

  const problems = gathered
    .reduce((total, tree) =>
      total + tree.findings.filter(finding => finding.severity === 'problem').length, 0);

  if (problems === 0) success('Cold storage matches the record — nothing to answer for');
  else warn(`${problems} thing${problems === 1 ? ' needs' : 's need'} attention — see above`);
};

// ── Internals ─────────────────────────────────────────────────────────────────

/**
 * Every section of this report is the same shape: a title, a line saying what it
 * is about, and a table.
 *
 * Held in one place because the value is the sameness. This is the command that
 * gets run to find out where things stand, often daily through a backfill, and
 * a reader who has learned to skim one section should not have to learn the
 * next. Three sections formatted three ways is three things to read.
 */
const block = (title: string, subtitle: string, table: ReturnType<typeof grid>): void => {
  spacer();
  info(`${C.bold}${title}${C.reset}  ${C.dim}${subtitle}${C.reset}`);
  spacer();

  console.log(table.toString());
};

/**
 * A table styled like the rest of the tooling, so `cold` and `data` look alike.
 *
 * **The heading row is coloured, not just bold.** A cell now holds three lines
 * of its own, so a page of this is a lot of text at one weight — and the first
 * thing a reader needs is the two edges that say what they are looking at. The
 * venue column is coloured to match, for the same reason and in the same hue:
 * together they frame the grid rather than decorating it.
 */
const grid = (head: string[], colAligns: ('left' | 'right')[], colWidths?: number[]) =>
  new Table({
    head:  head.map(column => `${C.bold}${C.cyan}${column}${C.reset}`),
    style: { head: [], border: [] },
    colAligns,
    ...(colWidths ? { colWidths, wordWrap: true } : {}),
  });

const examine = async (
  handle: DatabaseSync,
  config: ColdConfig,
  origin: Origin,
): Promise<{ origin: Origin; parts: ReturnType<typeof db.allParts>; findings: AuditFinding[] }> => {
  const remote   = await mega.listing(config.megaRoot);
  const parts    = db.allParts(handle, origin);
  const findings: AuditFinding[] = [];

  findings.push(...againstMega(handle, config, parts, remote));
  findings.push(...orphans(handle, origin, parts, remote));
  findings.push(...gaps(parts));
  findings.push(...staged(config, origin, parts, remote));
  findings.push(...unidentified(parts));
  findings.push(...duplicated(handle, origin));
  findings.push(...pending(handle, origin, remote));

  if (origin === 'vault') findings.push(...await stranded(handle, config));

  return { origin, parts, findings };
};

/**
 * Which side of each venue is holding eviction back, and what freeing it is worth.
 *
 * **Raw is only reclaimable once both ends are backed up** — the raw itself, and
 * the vault month it became. Either one missing blocks the month, so the useful
 * question is not "how much is in cold storage" but "which of the two is
 * behind", and that is a per-venue answer with an action attached: a venue whose
 * raw is safe and whose vault is not is N months of disk waiting on N vault
 * uploads, and on a slow uplink that ordering is the whole decision.
 *
 * **The vault is the pivot; everything else is a source compared against it.**
 * The raw archives today, the REST and websocket captures later — each produces
 * its own tree and the same vault, so every one of them asks the same question
 * of the same counterpart. Iterating the origins rather than naming them means a
 * new collector arrives with this section already written for it.
 *
 * Months, not bytes. Origins advance chronologically, so a count is the honest
 * signal; sizes would invite comparing a 10GB bybit month against a 70MB gate
 * one as though the numbers meant the same thing.
 */
const reclaim = (origins: Origin[]): void => {
  const sources = origins.filter(origin => origin !== 'vault');

  if (sources.length === 0 || ! origins.includes('vault')) return;

  const handle = db.open(loadConfig('vault').dbPath);

  try {
    const vault = backedMonths(handle, 'vault');

    for (const source of sources) {
      const theirs = backedMonths(handle, source);
      const size   = monthBytes(handle, source);
      const venues = [...new Set([...vault.keys(), ...theirs.keys()])];

      const rows = venues.map(venue => {
        const ours  = vault.get(venue)  ?? new Set<string>();
        const there = theirs.get(venue) ?? new Set<string>();
        const weigh = (months: string[]): number =>
          months.reduce((total, month) => total + (size.get(`${venue}/${month}`) ?? 0), 0);

        const free  = [...there].filter(month => ours.has(month));
        const onUs  = [...there].filter(month => ! ours.has(month));
        const onRaw = [...ours].filter(month => ! there.has(month));

        return {
          venue,
          free:  { months: free.length,  bytes: weigh(free) },
          onUs:  { months: onUs.length,  bytes: weigh(onUs) },
          onRaw: { months: onRaw.length, bytes: weigh(onRaw) },
        };
      }).filter(row => row.free.months + row.onUs.months + row.onRaw.months > 0);

      // Biggest win first: the venue whose vault uploads free the most disk is
      // the answer to the question this table exists to ask.
      rows.sort((a, b) => b.onUs.bytes - a.onUs.bytes || b.onUs.months - a.onUs.months);

      const table = grid(
        ['Venue', 'Evictable', 'Waiting on vault', `Waiting on ${source}`],
        ['left', 'right', 'right', 'right'],
      );

      for (const row of rows)
        table.push([
          row.venue,
          amount(row.free,  'good'),
          amount(row.onUs,  'wait'),
          amount(row.onRaw, 'wait'),
        ]);

      const sum = (pick: (row: typeof rows[number]) => { months: number; bytes: number }) =>
        rows.reduce((total, row) => ({
          months: total.months + pick(row).months,
          bytes:  total.bytes  + pick(row).bytes,
        }), { months: 0, bytes: 0 });

      table.push([
        `${C.dim}all${C.reset}`,
        `${C.dim}${plain(sum(row => row.free))}${C.reset}`,
        `${C.dim}${plain(sum(row => row.onUs))}${C.reset}`,
        `${C.dim}${plain(sum(row => row.onRaw))}${C.reset}`,
      ]);

      block('RECLAIM', `${source} — uploading a side frees the raw it holds back`, table);
    }
  } finally {
    db.close(handle);
  }
};

/**
 * One cell: how many months, and how much raw they are.
 *
 * **Nothing planned is not nothing there.** A month no part describes weighs
 * zero in the record and can weigh hundreds of gigabytes on disk — binance had
 * 58 such months against 297GB of raw. `0B` would read as "nothing to gain
 * here", which is the opposite of the truth, so an unweighable month says so
 * instead.
 */
const amount = (cell: { months: number; bytes: number }, tone: 'good' | 'wait'): string => {
  if (cell.months === 0) return `${C.dim}—${C.reset}`;

  const colour = tone === 'good' ? C.green : C.yellow;
  const size   = cell.bytes === 0 ? `${C.dim}unplanned${C.reset}` : fmtBytes(cell.bytes);

  return `${colour}${cell.months}${C.reset} ${C.dim}mo${C.reset}  ${size}`;
};

const plain = (cell: { months: number; bytes: number }): string =>
  (cell.months === 0 ? '—' : `${cell.months} mo  ${fmtBytes(cell.bytes)}`);

/**
 * `venue/month` → how much raw that month is, planned or sent.
 *
 * **Sized from the source, never from the vault**, because raw is what eviction
 * frees: the payoff for uploading a vault month is the archive month it unblocks,
 * and those two are not the same size — Parquet is a fraction of the zips it was
 * built from. One rule across all three columns, so the numbers can be added up.
 *
 * Counted whether or not the part has been sent, since the question is how much
 * disk the month occupies rather than how much of it is backed up. A month with
 * no parts at all is 0 and means exactly that: nothing has planned it yet, so
 * this cannot say what it weighs — an audit reads the record and never walks the
 * source tree.
 */
const monthBytes = (handle: DatabaseSync, origin: Origin): Map<string, number> => {
  const size = new Map<string, number>();

  for (const part of db.allParts(handle, origin)) {
    const key = `${part.venue}/${part.month}`;

    size.set(key, (size.get(key) ?? 0) + part.bytes);
  }

  return size;
};

/**
 * Venue → the months whose every part is in Mega.
 *
 * A month with one part still to send is not backed up: a restore needs all of
 * them, so counting it would claim a safety the month does not have.
 */
const backedMonths = (handle: DatabaseSync, origin: Origin): Map<string, Set<string>> => {
  const sent    = new Map<string, Set<string>>();
  const pending = new Set<string>();

  for (const part of db.allParts(handle, origin)) {
    const key = `${part.venue}/${part.month}`;

    if (! part.uploadedAt) pending.add(key);
    else {
      const months = sent.get(part.venue) ?? new Set<string>();

      months.add(part.month);
      sent.set(part.venue, months);
    }
  }

  for (const [venue, months] of sent)
    for (const month of [...months]) if (pending.has(`${venue}/${month}`)) months.delete(month);

  return sent;
};

/** The one-screen answer: what is in cold storage, by venue. */
const coverage = (
  gathered: { origin: Origin; parts: ReturnType<typeof db.allParts> }[],
): void => {
  const cells  = new Map<string, Holding>();
  const venues = new Set<string>();

  for (const { origin, parts } of gathered)
    for (const [venue, holding] of hold(parts)) {
      venues.add(venue);
      cells.set(`${venue}|${origin}`, holding);
    }

  const origins = gathered.map(tree => tree.origin);
  const table   = grid(['Venue', ...origins.map(title)],
    ['left', ...origins.map(() => 'left' as const)]);

  for (const venue of [...venues].sort())
    table.push([`${C.bold}${C.cyan}${venue}${C.reset}`,
      ...origins.map(origin => render(cells.get(`${venue}|${origin}`)))]);

  /**
   * An empty spanned row before the totals.
   *
   * The totals are a different kind of statement from the rows above them, and
   * a border alone does not say so — every row already has one. A blank line is
   * the cheapest thing that reads as "and now, everything".
   */
  table.push([{ colSpan: origins.length + 1, content: '' }]);

  table.push([`${C.bold}${C.gray}all${C.reset}`, ...origins.map(origin =>
    render(merge([...cells].filter(([key]) => key.endsWith(`|${origin}`)).map(([, held]) => held)),
      true))]);

  block('COLD STORAGE', gathered.length > 1 ? 'every tree, by venue' : title(origins[0]!), table);
};

/** Fold a tree's parts into one holding per venue. */
const hold = (parts: ReturnType<typeof db.allParts>): Map<string, Holding> => {
  const byMonth = new Map<string, { venue: string; parts: number; sent: number }>();
  const venues  = new Map<string, Holding>();

  for (const part of parts) {
    const holding = venues.get(part.venue) ?? {
      months: new Set<string>(), monthCount: 0, parts: 0, bytes: 0, files: 0,
      sent: 0, sentBytes: 0, sentMonths: 0,
    };

    holding.months.add(part.month);
    holding.parts++;
    holding.bytes += part.bytes;
    holding.files += part.files;

    if (part.uploadedAt) { holding.sent++; holding.sentBytes += part.bytes; }

    venues.set(part.venue, holding);

    const key   = `${part.venue}/${part.month}`;
    const month = byMonth.get(key) ?? { venue: part.venue, parts: 0, sent: 0 };

    month.parts++;

    if (part.uploadedAt) month.sent++;

    byMonth.set(key, month);
  }

  for (const month of byMonth.values())
    venues.get(month.venue)!.sentMonths += month.sent / month.parts;

  for (const holding of venues.values()) holding.monthCount = holding.months.size;

  return venues;
};

/**
 * Add holdings together, for the totals row.
 *
 * **Month counts add; month sets union.** They answer different questions and
 * only one of them belongs in a total — seven venues each holding 2020-03 are
 * seven venue-months of data, and unioning said `108 mo` under a column adding
 * to 252.
 */
const merge = (holdings: Holding[]): Holding => holdings.reduce((total, held) => ({
  months:     new Set([...total.months, ...held.months]),
  monthCount: total.monthCount + held.monthCount,
  parts:      total.parts      + held.parts,
  bytes:      total.bytes      + held.bytes,
  files:      total.files      + held.files,
  sent:       total.sent       + held.sent,
  sentBytes:  total.sentBytes  + held.sentBytes,
  sentMonths: total.sentMonths + held.sentMonths,
}), { months: new Set<string>(), monthCount: 0, parts: 0, bytes: 0, files: 0,
  sent: 0, sentBytes: 0, sentMonths: 0 });

/**
 * One cell: what is here, what it weighs, and how much of it is safe.
 *
 * **Three lines, in that order, because that is the order the questions come
 * in.** How far does this go, how big is it, and how much of it would survive
 * this disk dying. A column per data point instead put the answer to the third
 * question five columns from the answer to the first.
 *
 * The first line spans **everything known**, not just what is in Mega. That
 * reverses an earlier choice — the range used to be of uploaded months, because
 * `0 months` across `202109–202311` read as loss rather than backlog — and it is
 * only safe now because the third line says what is backed up in its own right.
 */
const render = (held: Holding | undefined, totals = false): string => {
  if (! held || held.parts === 0) return `${C.dim}—${C.reset}`;

  const months = [...held.months].sort();
  const span   = totals
    ? ''
    : ` ${C.dim}(${dashed(months[0]!)} → ${dashed(months[months.length - 1]!)})${C.reset}`;

  const dim = (text: string): string => (totals ? `${C.dim}${text}${C.reset}` : text);

  /**
   * A complete tree says so rather than repeating itself. `27 backed up (27.0
   * mo, 2.0GB)` under `27 parts (2.0GB)` is the same three numbers twice, and
   * four of seven venues are in exactly that state.
   */
  const safe = held.sent === held.parts
    ? `${totals ? C.dim : C.green}all backed up${C.reset} ${C.dim}(${fmtBytes(held.sentBytes)})${C.reset}`
    : `${totals ? C.dim : C.yellow}${held.sent.toLocaleString()} backed up${C.reset} `
      + `${C.dim}(${held.sentMonths.toFixed(1)} mo, ${fmtBytes(held.sentBytes)})${C.reset}`;

  return [
    dim(`${held.monthCount} mo`) + span,
    /**
     * **Size last on both lines that carry one**, so the two land in roughly
     * the same place and a glance down the cell compares them without reading
     * either. Putting bytes first put the number this is really about — how
     * much is safe — beside a file count on the line below it.
     */
    dim(`${held.parts.toLocaleString()} parts`)
      + ` ${C.dim}(${held.files.toLocaleString()} files, ${fmtBytes(held.bytes)})${C.reset}`,
    safe,
  ].join('\n');
};

/** `202107` as `2021-07`, since a cell holds two of them and they must not run together. */
const dashed = (month: string): string => `${month.slice(0, 4)}-${month.slice(4)}`;

/** `archives` as `Archives`, for a column heading. */
const title = (origin: Origin): string => origin[0]!.toUpperCase() + origin.slice(1);

/**
 * Every part the record calls backed up, against what Mega actually holds.
 *
 * **The size is computed, not remembered.** A member list predicts a tar's bytes
 * exactly — headers, padding, long names, the blocking factor — so comparing it
 * against the listing proves the object is the one those members describe,
 * without downloading anything. A remembered size would only prove the record
 * agrees with itself.
 */
const againstMega = (
  handle: DatabaseSync,
  config: ColdConfig,
  parts:  ReturnType<typeof db.allParts>,
  remote: Map<string, { bytes: number; handle: string | null }>,
): AuditFinding[] => {
  const found: AuditFinding[] = [];

  for (const part of parts) {
    if (! part.uploadedAt) continue;

    const object = remote.get(part.remote);

    if (! object) {
      found.push({ severity: 'problem', kind: 'missing from Mega',
        what: label(part), detail: remotePath(config, part) });

      continue;
    }

    const expected = tarSize(db.membersWith(handle, part.id));

    if (object.bytes !== expected)
      found.push({ severity: 'problem', kind: 'size disagrees',
        what: label(part),
        detail: `Mega ${fmtBytes(object.bytes)}, its ${part.files.toLocaleString()} members imply ${fmtBytes(expected)}` });

    if (part.handle && object.handle && part.handle !== object.handle)
      found.push({ severity: 'problem', kind: 'object replaced',
        what: label(part),
        detail: `recorded ${part.handle}, Mega now ${object.handle}` });
  }

  return found;
};

/**
 * Objects in Mega that no part describes — nothing can say what is inside them.
 *
 * **Except the ones a replan orphaned on purpose.** A month that repacks into
 * fewer parts leaves its highest-numbered objects holding members that now live
 * in the tars beside them, and those are recorded as ghosts the moment the plan
 * is made — they have no part row precisely *because* they are superseded. They
 * are removed once every replacement is confirmed uploaded, so between the two
 * they are an expected state rather than an unexplained object, and calling them
 * a problem buries the ones that are.
 */
const orphans = (
  handle: DatabaseSync,
  origin: Origin,
  parts:  ReturnType<typeof db.allParts>,
  remote: Map<string, { bytes: number; handle: string | null }>,
): AuditFinding[] => {
  const known  = new Set(parts.map(part => part.remote));
  const ghosts = new Set(db.ghosts(handle, origin));

  return [...remote.entries()]
    .filter(([path]) => ! known.has(path))
    .map(([path, object]) => (ghosts.has(path)
      ? {
        severity: 'check' as const, kind: 'awaiting removal',
        what: path.split('/').slice(-3).join('/'),
        detail: `${fmtBytes(object.bytes)} in Mega, replaced by a replan and not yet swept`,
      }
      : {
        severity: 'problem' as const, kind: 'nothing describes it',
        what: path.split('/').slice(-3).join('/'),
        detail: `${fmtBytes(object.bytes)} in Mega, no part row`,
      }));
};

/**
 * A month missing from the middle of a venue's range.
 *
 * Cold storage is filled oldest first, so the months a venue holds should be a
 * run without holes. A gap is not proof of loss — a venue may genuinely have
 * published nothing that month — but it is the shape a lost or skipped month
 * makes, and it is cheap to point at.
 */
const gaps = (parts: ReturnType<typeof db.allParts>): AuditFinding[] => {
  const byVenue = new Map<string, Set<string>>();

  for (const part of parts) {
    if (! part.uploadedAt) continue;

    byVenue.set(part.venue, (byVenue.get(part.venue) ?? new Set()).add(part.month));
  }

  const found: AuditFinding[] = [];

  for (const [venue, months] of [...byVenue].sort()) {
    const have    = [...months].sort();
    const missing = between(have[0]!, have[have.length - 1]!).filter(month => ! months.has(month));

    if (missing.length === 0) continue;

    found.push({ severity: 'check', kind: 'gap in the range',
      what: venue,
      detail: `${missing.length} month${missing.length === 1 ? '' : 's'} absent between `
        + `${have[0]} and ${have[have.length - 1]}: ${missing.slice(0, 8).join(', ')}`
        + (missing.length > 8 ? ` … +${missing.length - 8}` : '') });
  }

  return found;
};

/**
 * Tars still on disk, checked against the object they were meant to become.
 *
 * **Two copies that disagree is the loudest thing here.** Both are in hand — no
 * download, no inference — so if the local tar and the Mega object differ in
 * size, one of them is not what the record describes and the record cannot say
 * which. That outranks the housekeeping observation that space was never
 * reclaimed.
 */
const staged = (
  config: ColdConfig,
  origin: Origin,
  parts:  ReturnType<typeof db.allParts>,
  remote: Map<string, { bytes: number; handle: string | null }>,
): AuditFinding[] => {
  const found: AuditFinding[] = [];

  for (const part of parts) {
    /**
     * Sized in one step rather than asked-then-measured.
     *
     * A push may run beside this — it is read-only precisely so it can — and it
     * reclaims a staged tar the moment Mega confirms it. Between an `existsSync`
     * and a `statSync` that tar can vanish, and the audit would die reporting on
     * a run that was working correctly.
     */
    const here = sizeOf(localPath(config, origin, part));

    if (here === null) continue;

    const there = remote.get(part.remote);

    if (there && there.bytes !== here) {
      found.push({ severity: 'problem', kind: 'local and Mega differ',
        what: label(part),
        detail: `${fmtBytes(here)} staged here against ${fmtBytes(there.bytes)} in Mega — `
          + 'the same name holding two different tars' });

      continue;
    }

    if (part.uploadedAt)
      found.push({ severity: 'check', kind: 'staged tar not reclaimed',
        what: label(part),
        detail: `${fmtBytes(here)} on disk for a part already in Mega` });
  }

  return found;
};

/**
 * A part confirmed in Mega with no handle recorded.
 *
 * The handle is the only thing identifying the stored object independently of
 * its path, so without one a silent replacement — same name, same size,
 * different object — cannot be detected for that part, now or later.
 */
const unidentified = (parts: ReturnType<typeof db.allParts>): AuditFinding[] => {
  const rows = parts.filter(part => part.uploadedAt && ! part.handle);

  if (rows.length === 0) return [];

  return [{ severity: 'check', kind: 'no handle recorded',
    what: `${rows.length} part${rows.length === 1 ? '' : 's'}`,
    detail: 'a replacement of the same size could not be detected for these — '
      + `e.g. ${label(rows[0]!)}` }];
};

/**
 * A file recorded in more than one part.
 *
 * Ordinary after a rebuild — the old version stays in its tar and the new one is
 * packed beside it — so this is reported rather than condemned. It matters
 * because a restore has to know which copy is current, and because a runaway
 * count is how a replanning loop would show itself.
 */
const duplicated = (handle: DatabaseSync, origin: Origin): AuditFinding[] => {
  const rows = db.duplicatedPaths(handle, origin);

  if (rows.length === 0) return [];

  return [{ severity: 'check', kind: 'held in more than one part',
    what: `${rows.length.toLocaleString()} file${rows.length === 1 ? '' : 's'}`,
    detail: `e.g. ${rows[0]!.path} (${rows[0]!.copies} copies)` }];
};

/**
 * Partitions stocker recorded building that exist nowhere.
 *
 * **The one question cold storage cannot ask of itself.** Every other check here
 * compares the record against Mega or against the staging area — all of which
 * describe things cold storage put there. This one compares against what the
 * *producer* says it made, which is the only way a partition that was built and
 * then vanished can ever be noticed: it is in no part, so no part can be wrong
 * about it, and it is on no disk, so no walk trips over it.
 *
 * Three places, and only the third is a fault:
 *
 * - **on disk** — here, whether or not it is backed up yet
 * - **in cold storage** — evicted on purpose, or simply not on this machine
 * - **neither** — built, and gone, with no copy anywhere
 *
 * A problem rather than a check, because there is no innocent explanation. It
 * means either something deleted partitions outside this family, or they were
 * moved somewhere nothing here can see — and both are found the same way and
 * both need an answer before the next `evict` or `push` acts on the record.
 *
 * Costs one vault walk, which is the only walk this command does. Worth it: the
 * alternative is that the failure is silent by construction.
 */
const stranded = async (
  handle: DatabaseSync,
  config: ColdConfig,
): Promise<AuditFinding[]> => {
  const here = new Set<string>();

  for (const file of await scanVault(config.sourceRoot)) here.add(idOf(file));
  for (const row of db.uploaded(handle, 'vault')) here.add(idOf(row));

  const found: AuditFinding[] = [];

  for (const venue of new Set(db.allParts(handle, 'vault').map(part => part.venue)
    .concat(venuesInLedger(config.vaultRoot)))) {
    const missing: string[] = [];

    for (const ids of (await idsByMonth(config.vaultRoot, venue)).values())
      for (const id of ids) if (! here.has(id)) missing.push(id);

    if (missing.length === 0) continue;

    const months = new Set(missing.map(id => id.slice(id.lastIndexOf('|') + 1)));

    found.push({
      severity: 'problem',
      kind:     'built but nowhere',
      what:     `${venue} — ${missing.length.toLocaleString()} partitions`,
      detail:   `across ${months.size} month${months.size === 1 ? '' : 's'}, `
        + `stocker's ledger records them and neither the vault nor Mega has them `
        + `(e.g. ${missing[0]})`,
    });
  }

  return found;
};

/** Which venues the ledger directory names, however little cold storage knows. */
const venuesInLedger = (vaultRoot: string): string[] => {
  try {
    return [...new Set(fs.readdirSync(path.join(vaultRoot, '@meta', 'built'))
      .filter(name => name.endsWith('.jsonl'))
      .map(name => name.split('.')[1]!))];
  } catch {
    return [];
  }
};

/** Descriptions still waiting on a replacement, and plans not yet sent. */
const pending = (
  handle: DatabaseSync,
  origin: Origin,
  remote: Map<string, { bytes: number; handle: string | null }>,
): AuditFinding[] => {
  const found: AuditFinding[] = [];
  const waiting = db.supersededPaths(handle, origin);

  /**
   * Named rather than counted. Each of these is an object Mega still holds and
   * a plan intends to overwrite, so "25 objects" answers nothing a reader can
   * act on — which month, how big, and whether the size Mega reports is still
   * the one the old description implies are the questions, and they are per
   * object.
   */
  for (const path of waiting) {
    const was  = [...db.supersededAt(handle, origin, path).values()];
    const held = remote.get(path);

    /**
     * **What Mega actually holds decides which of three things this is**, and
     * saying "in Mega" regardless described an object that may not be there.
     */
    found.push(held === undefined
      ? {
        severity: 'check' as const, kind: 'description outlived its object',
        what: path.split('/').slice(-3).join('/'),
        detail: `${was.length} file${was.length === 1 ? '' : 's'} described, but Mega holds `
          + 'nothing here — the next push clears it',
      }
      : {
        severity: 'check' as const, kind: 'replacement outstanding',
        what: path.split('/').slice(-3).join('/'),
        detail: `${was.length} file${was.length === 1 ? '' : 's'}, ${fmtBytes(held.bytes)} in Mega`
          + (held.bytes === tarSize(was) ? '' : ' — not the size those files imply')
          + ' — a newer tar was planned and has not landed yet',
      });
  }

  /**
   * The backlog is not reported here. What is planned and what is in Mega are
   * two of the three lines of every cell in the coverage table, per venue and
   * per origin — which is strictly more than one number under one table said.
   */
  return found;
};

/**
 * Findings, grouped so a real problem cannot hide behind a routine one.
 *
 * Three weights and they are not decoration. A **problem** is cold storage
 * disagreeing with the record and needs an answer. A **check** is something
 * that has an innocent explanation and a guilty one, worth a look. A **note** is
 * ordinary progress. Printing them in one flat list is how the first gets lost
 * among thirty of the last.
 */
const report = (origin: Origin, findings: AuditFinding[]): void => {
  for (const [severity, colour, heading, subtitle, limit] of [
    ['problem', C.red,    'PROBLEMS',     'cold storage does not match the record', 40],
    ['check',   C.yellow, 'WORTH A LOOK', 'an innocent explanation and a guilty one', 12],
  ] as const) {
    const rows = findings.filter(finding => finding.severity === severity);

    if (rows.length === 0) continue;

    /**
     * Fixed widths and wrapping, because a detail is a sentence. Left to
     * itself the column grows to the longest one and the table runs off the
     * screen, which loses the two columns that say what the finding is.
     */
    const table = grid(['Finding', 'What', 'Detail'], ['left', 'left', 'left'], [21, 30, 56]);

    for (const row of rows.slice(0, limit))
      table.push([`${colour}${row.kind}${C.reset}`, row.what, `${C.dim}${row.detail}${C.reset}`]);

    /**
     * Truncated inside the table rather than after it, so the count cannot be
     * read as a row of its own — the last line of a long list is exactly where
     * a reader stops looking carefully.
     */
    if (rows.length > limit)
      table.push([`${C.dim}…${C.reset}`, `${C.dim}and ${rows.length - limit} more${C.reset}`, '']);

    /**
     * The tree is in the heading rather than in a column, because a finding
     * names a part and never says which tree that part belongs to — and
     * `202110.p01.tar` exists under both.
     */
    block(`${heading} · ${origin}`, subtitle, table);
  }
};

/** A file's size, or null if it is not there — including if it left just now. */
const sizeOf = (path: string): number | null => {
  try {
    return fs.statSync(path).size;
  } catch {
    return null;
  }
};

const label = (part: { origin: string; venue: string; name: string }): string =>
  `${part.venue}/${part.name}`;

/** Every month from one to another, inclusive, as `yyyymm`. */
const between = (from: string, to: string): string[] => {
  const months: string[] = [];
  const at  = new Date(Date.UTC(Number(from.slice(0, 4)), Number(from.slice(4)) - 1, 1));
  const end = new Date(Date.UTC(Number(to.slice(0, 4)), Number(to.slice(4)) - 1, 1));

  for (; at <= end; at.setUTCMonth(at.getUTCMonth() + 1))
    months.push(at.toISOString().slice(0, 7).replace('-', ''));

  return months;
};

// ── Test access ───────────────────────────────────────────────────────────────

export const _test_gaps        = gaps;
export const _test_between     = between;
export const _test_againstMega = againstMega;
export const _test_orphans     = orphans;
export const _test_staged       = staged;
export const _test_unidentified = unidentified;
export const _test_backedMonths = backedMonths;
export const _test_monthBytes   = monthBytes;
export const _test_hold         = hold;
export const _test_merge        = merge;
export const _test_render       = render;
