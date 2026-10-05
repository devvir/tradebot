import fs from 'node:fs';
import path from 'node:path';
import Table from 'cli-table3';
import { loadConfig, localPath, remotePath } from './config';
import { tarSize } from './tar';
import { scanVault } from './scan';
import { idsFor, surveyVault } from './presence';
import { openFacts } from './ledger';
import { fmtBytes } from '../../shared/utils/format';
import { C } from '../../shared/utils/colors';
import * as db from './db';
import * as mega from './mega';
import { spacer, success, warn } from '../../shared/ui/logger';
import type { DatabaseSync } from 'node:sqlite';
import type { AuditFinding, ColdConfig, Holding, Known, Lag, Origin } from './types';

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
  const gathered: { origin: Origin; parts: ReturnType<typeof db.allParts>;
    findings: AuditFinding[]; known: Map<string, Known> }[] = [];

  for (const origin of origins) {
    const config = loadConfig(origin);
    const handle = db.open(config.dbPath);

    try {
      gathered.push(await examine(handle, config, origin));
    } finally {
      db.close(handle);
    }
  }

  steps.done();

  /**
   * **The whole report is one repaintable page.**
   *
   * Walking 3.7 million archive files takes 21 seconds, and every other number
   * is already known — so the page is printed at once and the sizes fill in as
   * each venue lands. Findings and the reclaim table are computed once and
   * reprinted unchanged: they depend on nothing being measured, and holding them
   * back until the walk finished was the odd part, since neither has anything to
   * do with it.
   */
  const rest = [
    /**
     * Findings stay per origin. They name a part and not the tree it belongs to,
     * so merging them into one table would drop the only thing that says which —
     * and a heading per origin costs nothing next to that.
     */
    ...gathered.map(({ origin, findings }) => report(origin, findings)),
    reclaim(origins),
  ].filter(Boolean).join('\n');

  const page = coverage(gathered, rest);

  // Off a terminal there is no cursor to move, so everything is measured first
  // and printed once — a piped table reading `Counting…` for ever is worse.
  if (! process.stdout.isTTY) await fill(gathered, () => { /* nothing to redraw */ });

  page.show();

  if (process.stdout.isTTY) await fill(gathered, () => { page.show(); });

  spacer();

  const problems = gathered
    .reduce((total, tree) =>
      total + tree.findings.filter(finding => finding.severity === 'problem').length, 0);

  if (problems === 0) success('Cold storage matches the record — nothing to answer for');
  else warn(`${problems} thing${problems === 1 ? ' needs' : 's need'} attention — see above`);
};

/**
 * What it is doing, while it is doing it.
 *
 * **Ten seconds of silence is indistinguishable from a hang.** The work is a
 * Mega listing, a walk of 140,000 files and a read of 169,000 facts, and none
 * of it prints anything until all of it is finished — so the only thing to look
 * at is a cursor.
 *
 * The lines are erased before the report, because they are scaffolding and not
 * findings: what is left on screen afterwards should be the answer, exactly as
 * it was before. Watching which one sits there longest is also the cheapest
 * profiler there is, which is the other reason to name the steps rather than
 * spin a generic bar.
 *
 * **Only on a terminal.** Piped into a file or a `grep`, the escape codes would
 * be the output, so there they are simply never written.
 */
const steps = {
  shown: 0,

  say(what: string): void {
    if (! process.stdout.isTTY) return;

    console.log(`${C.dim}⋯ ${what}…${C.reset}`);
    this.shown++;
  },

  /** Up over what was written, then clear from the cursor to the end. */
  done(): void {
    if (! process.stdout.isTTY || this.shown === 0) return;

    process.stdout.write(`\x1b[${this.shown}A\x1b[J`);
    this.shown = 0;
  },
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
const block = (
  title:    string,
  subtitle: string,
  table:    ReturnType<typeof grid>,
  note     = '',
): string =>
  ['', `${C.cyan}ℹ${C.reset} ${C.bold}${title}${C.reset}  ${C.dim}${subtitle}${C.reset}`, '',
    table.toString(), ...(note ? [note] : [])].join('\n');

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
): Promise<{ origin: Origin; parts: ReturnType<typeof db.allParts>;
  findings: AuditFinding[]; known: Map<string, Known> }> => {
  steps.say(`Listing Mega — ${origin}`);

  const remote   = await mega.listing(config.megaRoot);
  const parts    = db.allParts(handle, origin);

  steps.say(`Checking ${parts.length} ${origin} parts against Mega`);
  const findings: AuditFinding[] = [];

  findings.push(...againstMega(handle, config, parts, remote));
  findings.push(...orphans(handle, origin, parts, remote));
  findings.push(...gaps(parts));
  findings.push(...staged(config, origin, parts, remote));
  findings.push(...unidentified(parts));
  findings.push(...duplicated(handle, origin));
  findings.push(...pending(handle, origin, remote));

  if (origin === 'vault') findings.push(...await stranded(handle, config));

  /**
   * **The vault is measured now and the archives are not.** The vault tree is
   * already being walked for the check above, so its sizes are a by-product; the
   * archives are 3.7 million files and 21 seconds, which is the whole reason the
   * table paints before they are counted.
   */
  const known = await producers(handle, config, origin, origin === 'vault');

  return { origin, parts, findings, known };
};

/**
 * What a venue actually has: the months its producer finished, and the files
 * that make them up wherever those currently sit.
 *
 * Cold storage can only answer what it packed, which is a different question —
 * a venue never pushed has no rows to fold and rendered as a dash over however
 * much data it held.
 *
 * **On disk plus evicted, never one or the other.** Counting only what is on
 * disk makes a venue shrink as it is backed up and cleaned, which is precisely
 * backwards; counting cold storage instead misses everything not yet packed. The
 * two sets are disjoint by construction — an evicted file is one that was
 * deleted locally — so adding them is the venue's true size.
 */
const producers = async (
  handle:  DatabaseSync,
  config:  ColdConfig,
  origin:  Origin,
  measure: boolean,
): Promise<Map<string, Known>> => {
  const facts = openFacts(config);
  const known = new Map<string, Known>();

  const of = (venue: string): Known => {
    const held = known.get(venue)
      ?? { months: new Set<string>(), files: 0, bytes: 0, gone: 0, goneBytes: 0, measured: false };

    known.set(venue, held);

    return held;
  };

  steps.say(`Reading what the producers say they have — ${origin}`);

  try {
    const topic = origin === 'vault' ? 'vault' : 'archives';
    const fact  = origin === 'vault' ? 'built' : 'complete';

    for (const stated of facts.find({ topic, fact })) of(stated.venue).months.add(stated.period);

    // Only the vault can be short by design, so only the vault is asked.
    if (origin === 'vault')
      for (const stated of facts.find({ topic, fact: 'spills' })) of(stated.venue).spills = true;
  } finally {
    facts.close();
  }

  /**
   * **What is on disk, measured rather than inferred.** The producers record no
   * size, and a count of what they built says nothing about what is still here
   * — the point of the line is comparing what exists against what is safe.
   */
  /**
   * **Every venue with a directory, whether or not anything else knows it.**
   * The rows are fixed before the first paint, so a venue the walk discovers
   * later could never appear — and a venue nothing has closed and nothing has
   * packed is exactly the one worth seeing: binance holds 102,850 files and
   * 295.8GB that no other source here mentions. One `readdir`, no walk.
   *
   * Only where the tree is venue-major, which is the archives. The vault names
   * its top level `venue=…` and keeps scratch directories beside it, so reading
   * it this way invents venues called `venue=bitget` and `.stocker-tmp` — and it
   * needs none of this, since its own walk has already named every venue by the
   * time this runs.
   */
  if (! measure)
    for (const entry of fs.readdirSync(config.sourceRoot, { withFileTypes: true }))
      if (entry.isDirectory() && ! entry.name.startsWith('@') && ! entry.name.startsWith('.'))
        of(entry.name);

  if (measure) {
    steps.say(`Measuring ${config.sourceRoot}`);

    for (const [venue, { files, bytes }] of await onDisk(config.sourceRoot, origin)) {
      const held = of(venue);

      held.files    = files;
      held.bytes    = bytes;
      held.measured = true;
    }

    for (const held of known.values()) held.measured = true;
  }

  /**
   * **Plus what was reclaimed**, which is on nobody's disk and would otherwise
   * make a venue appear to shrink as it is backed up and cleaned. The two sets
   * cannot overlap: a file recorded here is one that was deleted locally.
   */
  for (const [venue, { files, bytes }] of db.evicted(handle, origin)) {
    const held = of(venue);

    held.gone      = files;
    held.goneBytes = bytes;
  }

  return known;
};

/**
 * Every venue's local footprint, counted with one walk.
 *
 * The vault is walked file by file because the audit needs its paths anyway for
 * the `built but nowhere` check, so the count is a by-product. The archives are
 * far larger and nothing else here needs their paths, so only the totals are
 * kept.
 */
const onDisk = async (
  root:   string,
  origin: Origin,
  only?:  string,
): Promise<[string, { files: number; bytes: number }][]> => {
  const found = new Map<string, { files: number; bytes: number }>();

  if (origin === 'vault') {
    for (const file of await scanVault(root)) {
      if (only && file.venue !== only) continue;

      const held = found.get(file.venue) ?? { files: 0, bytes: 0 };

      held.files++;
      held.bytes += file.bytes;
      found.set(file.venue, held);
    }

    return [...found];
  }

  for (const venue of fs.readdirSync(root, { withFileTypes: true })) {
    if (! venue.isDirectory() || venue.name.startsWith('@')) continue;
    if (only && venue.name !== only) continue;

    const held  = { files: 0, bytes: 0 };
    const stack = [path.join(root, venue.name)];

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

        const absolute = path.join(dir, entry.name);

        if (entry.isDirectory()) { stack.push(absolute); continue; }
        if (! entry.isFile()) continue;

        try {
          held.bytes += fs.statSync(absolute).size;
          held.files++;
        } catch {
          // Gone between the listing and the stat; it is not here either way.
        }
      }
    }

    found.set(venue.name, held);
  }

  return [...found];
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
const reclaim = (origins: Origin[]): string => {
  const out: string[] = [];

  const sources = origins.filter(origin => origin !== 'vault');

  if (sources.length === 0 || ! origins.includes('vault')) return '';

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

      out.push(block('RECLAIM', `${source} — uploading a side frees the raw it holds back`, table));
    }
  } finally {
    db.close(handle);
  }

  return out.join('\n');
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

/**
 * The one-screen answer: what each venue has, and how much of it is safe.
 *
 * **What exists comes from the producer; what is safe comes from cold storage.**
 * Both lines used to be read off the `part` rows, which meant a venue with
 * nothing backed up had no rows to fold and rendered as a dash — making "there
 * is nothing here" and "none of this is backed up" identical on the one screen
 * that exists to tell them apart. bybit showed a dash over 15,762 partitions
 * across 49 months, none of them in Mega.
 */
const coverage = (
  gathered: { origin: Origin; parts: ReturnType<typeof db.allParts>; known: Map<string, Known> }[],
  rest:     string,
): { show: () => void } => {
  const origins = gathered.map(tree => tree.origin);
  const venues  = new Set<string>();

  for (const { parts, known } of gathered)
    for (const venue of new Set([...hold(parts).keys(), ...known.keys()])) venues.add(venue);

  let lines = 0;

  /**
   * Built fresh each time, because the numbers it reads change underneath it —
   * that is the point. The venue set does not, so the table is the same shape
   * whichever paint this is.
   */
  const paint = (): string => {
    const cells = new Map<string, Holding>();

    for (const { origin, parts, known } of gathered) {
      const held = hold(parts);

      for (const venue of venues)
        cells.set(`${venue}|${origin}`, {
          ...(held.get(venue) ?? {
            months: new Set<string>(), monthCount: 0, parts: 0, bytes: 0, files: 0,
            sent: 0, sentBytes: 0, sentMonths: 0,
          }),
          known: known.get(venue),
          unit:  origin === 'vault' ? 'partitions' : 'files',
        });
    }

    const table = grid(['Venue', ...origins.map(title)],
      ['left', ...origins.map(() => 'left' as const)]);

    /**
     * The vault is built *from* the archives, so its months trailing theirs is a
     * statement about normalisation falling behind collection — the one
     * comparison between two cells of a row that means anything. The other
     * direction cannot happen and is not looked for.
     *
     * **Which months, not how many.** A venue can be short by one and current,
     * or short by one because a month in the middle never built, and only the
     * identity of the missing month tells them apart. That matters for the
     * excuse below: it applies to the newest closed month and to no other.
     */
    const standing = (venue: string): Lag => {
      if (! origins.includes('archives')) return null;

      const vault  = cells.get(`${venue}|vault`);
      const built  = vault?.known?.months ?? new Set<string>();
      const closed = [...(cells.get(`${venue}|archives`)?.known?.months ?? [])].sort();
      const short  = closed.filter(month => ! built.has(month));

      if (short.length === 0) return null;

      /**
       * A spilling venue's newest closed month holds its own tail in a month
       * the collector has not closed, so it cannot be built and the vault is
       * finished at one month short. Only that month is ever excused — anything
       * older is genuinely outstanding, whatever the venue's buckets do.
       */
      return vault?.known?.spills && short.length === 1 && short[0] === closed[closed.length - 1]
        ? 'excused'
        : 'behind';
    };

    let excused = false;

    for (const venue of [...venues].sort()) {
      const lag = standing(venue);

      if (lag === 'excused') excused = true;

      table.push([`${C.bold}${C.cyan}${venue}${C.reset}`,
        ...origins.map(origin =>
          render(cells.get(`${venue}|${origin}`), false, origin === 'vault' ? lag : null))]);
    }

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

    /**
     * Printed only when a cell carries the mark, so the table does not explain
     * a condition nobody is looking at.
     */
    const footnote = excused
      ? `${C.green}*${C.reset} ${C.dim}complete. This venue's buckets do not cut at UTC midnight, so a `
        + `month's tail arrives in the next month's first file — its newest closed month cannot be `
        + `built until the collector closes the one after it.${C.reset}`
      : '';

    return block('COLD STORAGE',
      gathered.length > 1 ? 'every tree, by venue' : title(origins[0]!), table, footnote);
  };

  return {
    /**
     * Up over exactly what was drawn, then draw it again.
     *
     * The page cannot change height between paints — the venues are known before
     * the first one, and `Counting…` occupies a cell the way a size does — so
     * the only thing that moves is the text inside. Off a terminal nothing is
     * erased and this simply prints once.
     */
    show(): void {
      if (lines > 0 && process.stdout.isTTY) process.stdout.write(`\x1b[${lines}A\x1b[J`);

      const text = [paint(), rest].filter(Boolean).join('\n');

      console.log(text);

      lines = text.split('\n').length + 1;
    },
  };
};

/**
 * Measure each tree that was left unmeasured, redrawing as each venue lands.
 *
 * Venue by venue rather than all at once, because the whole point is that the
 * numbers appear as they are found — and the venues differ by an order of
 * magnitude, from okx at 0.3 seconds to htx at 7.3.
 */
const fill = async (
  gathered: { origin: Origin; known: Map<string, Known> }[],
  repaint:  () => void,
): Promise<void> => {
  for (const { origin, known } of gathered) {
    if ([...known.values()].every(held => held.measured)) continue;

    const config = loadConfig(origin);

    for (const [venue, held] of known) {
      const [measured] = await onDisk(config.sourceRoot, origin, venue);

      held.files    = measured?.[1].files ?? 0;
      held.bytes    = measured?.[1].bytes ?? 0;
      held.measured = true;

      repaint();
    }
  }
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
  monthCount: total.monthCount + (held.known?.months.size ?? held.monthCount),
  parts:      total.parts      + held.parts,
  bytes:      total.bytes      + held.bytes,
  files:      total.files      + (held.known?.files ?? held.files),
  sent:       total.sent       + held.sent,
  sentBytes:  total.sentBytes  + held.sentBytes,
  sentMonths: total.sentMonths + held.sentMonths,
  unit:       held.unit ?? total.unit,
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
/**
 * How many months a cell claims: the producer's count where it has stated one,
 * cold's otherwise.
 *
 * Shared so the number printed and the number compared against cannot drift —
 * a lag drawn from one definition and shown from another would colour a cell
 * against the figure beside it.
 */
const monthsIn = (held: Holding | undefined): number =>
  (! held ? 0 : held.known?.months.size ? held.known.months.size : held.monthCount);

const render = (held: Holding | undefined, totals = false, lag: Lag = null): string => {
  if (! held || (held.parts === 0 && ! held.known)) return `${C.dim}—${C.reset}`;

  /**
   * The producer's months where it has stated any, cold's otherwise. They agree
   * for everything backed up, and where they differ the producer is the one
   * answering "what is there" — which is what the first two lines are about.
   */
  const months = [...(held.known?.months.size ? held.known.months : held.months)].sort();
  const span   = totals || months.length === 0
    ? ''
    : ` ${C.dim}(${dashed(months[0]!)} → ${dashed(months[months.length - 1]!)})${C.reset}`;

  const count = held.known ? held.known.files + held.known.gone : held.files;
  const dim   = (text: string): string => (totals ? `${C.dim}${text}${C.reset}` : text);

  /**
   * A complete tree says so rather than repeating itself. `27 backed up (27.0
   * mo, 2.0GB)` under `27 parts (2.0GB)` is the same three numbers twice, and
   * four of seven venues are in exactly that state.
   */
  /**
   * **One shape for every state, and the colour carries the verdict.**
   * `all backed up` alongside `41 backed up` was two formats to learn, and its
   * unit was redundant when the numbers matched and misleading when they did
   * not — `all` meant every *part*, which a reader takes as every *month*.
   *
   * Months, because that is what the line above states: `41 mo backed up` under
   * `42 mo` is a comparison anyone can make without doing arithmetic, and parts
   * are a packing detail no one asks this table about. Where a part matters —
   * a gap, a tar not in Mega — the findings say so in parts, which is where the
   * unit belongs.
   *
   * Counted fractionally, so a month half of whose parts have landed shows as
   * a fraction rather than rounding into a claim either way.
   */
  const whole = held.sent === held.parts
    && Math.round(held.sentMonths) >= (held.known?.months.size ?? held.monthCount);

  const safe = held.sent === 0
    ? `${totals ? C.dim : C.red}nothing backed up${C.reset}`
    : `${totals ? C.dim : whole ? C.green : C.yellow}`
      + `${held.sentMonths.toFixed(held.sentMonths % 1 === 0 ? 0 : 1)} mo backed up${C.reset} `
      + `${C.dim}(${fmtBytes(held.sentBytes)})${C.reset}`;

  /**
   * **The month count carries its own verdict.**
   *
   * A vault month exists because an archives month was complete, so the two
   * should meet. Yellow where they do not: whole finished months have never
   * been normalised, which is a backlog rather than a fault, and the number it
   * is short of is already one column over.
   *
   * **Green and starred where the shortfall is the venue's own shape.** A
   * spilling venue can never build its newest closed month, so it sits one month
   * behind for as long as that month is the tip — permanently yellow, for a
   * state nobody can act on and nobody should keep re-investigating. The star
   * sends it to the footnote instead of leaving the reader to remember which
   * venues cut their buckets where.
   */
  const covered = totals || ! lag
    ? dim(`${monthsIn(held)} mo`)
    : lag === 'behind'
      ? `${C.yellow}${monthsIn(held)} mo${C.reset}`
      : `${C.green}${monthsIn(held)} mo*${C.reset}`;

  return [
    covered + span,
    /**
     * **What is here leads; the tars it is packed into follow.** A part is cold
     * storage's own unit and says nothing about how much a venue holds, so
     * leading with it left the real quantity in a parenthesis — and rendered
     * nothing at all for a venue with no parts yet.
     *
     * **Size last on both lines that carry one**, so the two land in roughly the
     * same place and a glance down the cell compares them without reading
     * either.
     */
    dim(held.known && ! held.known.measured
      // Nothing is claimed until it has been counted: a zero here would read as
      // an answer, and the count itself is not known until the walk finishes.
      ? `${C.dim}Counting…${C.reset}`
      : `${count.toLocaleString()} ${held.unit ?? 'files'}`
        + (held.known
          ? ` ${C.dim}(${fmtBytes(held.known.bytes + held.known.goneBytes)})${C.reset}`
          : '')),
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
  steps.say('Reading what the services say they built, then scanning the vault tree');

  const found: AuditFinding[] = [];

  /**
   * **Both halves from one call**, so the facts cannot be read after the walk —
   * see `presence.ts` for why that ordering is this check's whole correctness.
   */
  const { claimed, present } = await surveyVault(handle, config);

  {
    const short = new Map<string, string[]>();

    for (const venue of claimed.keys()) {
      const missing = idsFor(claimed, venue).filter(id => ! present.has(id));

      if (missing.length > 0) short.set(venue, missing);
    }

    for (const [venue, missing] of [...short].sort()) {

      const months = new Set(missing.map(id => id.slice(id.lastIndexOf('|') + 1)));

      found.push({
        severity: 'problem',
        kind:     'built but nowhere',
        what:     `${venue} — ${missing.length.toLocaleString()} partitions`,
        detail:   `across ${months.size} month${months.size === 1 ? '' : 's'}, `
          + `stocker says it built them and neither the vault nor Mega has them `
          + `(e.g. ${missing[0]})`,
      });
    }
  }

  return found;
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
const report = (origin: Origin, findings: AuditFinding[]): string => {
  const out: string[] = [];

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
    out.push(block(`${heading} · ${origin}`, subtitle, table));
  }

  return out.join('\n');
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
