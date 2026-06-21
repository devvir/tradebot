import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { isDryRun } from '../options';
import { error, info, section, success, warn } from '../../../shared/ui/logger';
import type { Out, SourceFile } from './types';

/**
 * One-time re-bucketing of already-deduped WS source CSVs so each message lands
 * in the day file matching its exchange `timestamp` rather than the collector
 * reception time it was originally filed under. Every item in a BitMEX message
 * shares one `timestamp`, so the message-start line decides the destination day
 * for the whole message — continuation rows follow it, nothing is split.
 *
 * Reads plain CSV (decompress the sources yourself): input `<day>.<infix>.csv`,
 * output `<day>.<infix>.rebucketed.csv.gz` written beside it. As soon as a source
 * day finishes, its plain CSV and every no-longer-writable rebucket output are
 * handed to a background `pigz` (fire-and-forget — failures are tolerated), so the
 * deliverable is the gzip, never the 12–15× larger plain rebucketed CSV, and the
 * disk both occupied is freed as the run advances. No dedup or reordering — the
 * message count is an invariant, surfaced as total-in == total-out.
 *
 * Memory and open-fd count are bounded by the read buffer plus the few live
 * output days, never the file size: files are streamed in fixed chunks and each
 * contiguous run of same-day lines is written straight from the read buffer.
 * Only the current source day and the day before it are kept open; older outputs
 * are finalized (handle closed, `.tmp` dropped, gzip launched) the moment input
 * advances past them. A message landing ≥2 days behind its source file is
 * unexpected enough to crash the run rather than be quietly rewritten.
 *
 * One-time, throwaway: the source set is one file per day with no gaps, so the
 * run walks days strictly forward from the lowest present up to a hardcoded last
 * day. Each step waits for the next day's CSV to become available — it exists and
 * its `.gz` no longer does (proof decompression finished) — sleeping and retrying
 * until it appears, so the run can be launched while later buckets are still being
 * decompressed in parallel. Delete this tool once the backfill is rebucketed.
 */
export async function runRebucket(root: string): Promise<void> {
  const sources = discoverSources(root);

  if (sources.length === 0) {
    warn('No source folders with <day>.<infix>.csv files found.');

    return;
  }

  for (const folder of sources) await rebucketFolder(folder);
}

// ── Per-folder pipeline (one source) ───────────────────────────────────────────

const COMMA      = 0x2c; // ,
const UNDERSCORE = 0x5f; // _
const NL         = 0x0a; // \n
const CHUNK      = 1 << 23; // 8 MiB read buffer
const LAST_DAY   = '20260623'; // inclusive stop; from 20260624 sources are already bucketed right
const POLL_MS    = 90_000; // re-check for the next day's CSV every 1.5 min while it decompresses

async function rebucketFolder(folder: string): Promise<void> {
  const files = listSourceFiles(folder);

  if (files.length === 0) return;

  const infix    = files[0]!.infix;
  const dayInfix = new Map(files.map(f => [f.day, f.infix]));

  // The header is shared by every file of a source; take it from the first and
  // reuse it for every output. The timestamp column position comes from it.
  const headerLine   = readFirstLine(path.join(folder, files[0]!.name));
  const timestampIdx = headerLine.split(',').indexOf('timestamp');

  section(`Rebucket — ${path.basename(folder)}  (${files.length} day file(s))`);

  if (timestampIdx === -1) {
    warn(`Skipping ${path.basename(folder)} — no timestamp column in the header`);

    return;
  }

  const dryRun = isDryRun();
  const header = Buffer.from(headerLine + '\n');
  const outs   = new Map<string, Out>();   // destDay → open output (current + day-before only)
  const inCnt  = new Map<string, number>(); // input fileDay → messages read
  const outCnt = new Map<string, number>(); // destDay → messages written

  let totalIn  = 0;
  let totalOut = 0;

  const getOut = (day: string, fallbackInfix: string): Out => {
    let out = outs.get(day);

    if (! out) {
      const infix = dayInfix.get(day) ?? fallbackInfix;
      const final = path.join(folder, `${day}.${infix}.rebucketed.csv`);
      const fd    = dryRun ? -1 : fs.openSync(final + '.tmp', 'w');

      out = { fd, final };
      outs.set(day, out);

      if (fd !== -1) fs.writeSync(fd, header);
    }

    return out;
  };

  // Walk days strictly forward from the lowest present up to LAST_DAY, waiting for
  // each day's CSV to finish decompressing before processing it.
  for (let day = files[0]!.day; dayNum(day) <= dayNum(LAST_DAY); day = nextDay(day)) {
    const name     = `${day}.${infix}.csv`;
    const filePath = path.join(folder, name);

    await waitUntilReady(filePath);
    info(name);

    const msgs = processFile(filePath, timestampIdx, { name, day, infix }, getOut, outCnt);

    inCnt.set(day, msgs);
    totalIn  += msgs;
    totalOut += msgs;

    // The source day is done. Every rebucket output for an earlier day can now
    // receive no further writes (the next source is a later day, whose window
    // reaches back only one day), so close and gzip them; and the plain source
    // CSV is no longer needed. Both are freed here, not at the end of the run.
    finalizeOlderThan(outs, dayNum(day));

    if (! dryRun) gzip(filePath);
  }

  for (const out of outs.values()) finalize(out);

  report(inCnt, outCnt, totalIn, totalOut);
}

/** Block until `csvPath` is fully decompressed: the CSV exists and its `.gz` is gone. */
async function waitUntilReady(csvPath: string): Promise<void> {
  while (! (fs.existsSync(csvPath) && ! fs.existsSync(csvPath + '.gz'))) {
    warn(`Waiting for ${path.basename(csvPath)} — CSV missing or .gz still present (still decompressing). Retry in ${POLL_MS / 1000}s.`);

    await sleep(POLL_MS);
  }
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** The YYYYMMDD calendar day after `day`. */
function nextDay(day: string): string {
  return new Date((dayNum(day) + 1) * 86_400_000).toISOString().slice(0, 10).replace(/-/g, '');
}

/** Close an output's handle, drop the `.tmp` suffix, and launch a background gzip. */
function finalize(out: Out): void {
  if (out.fd === -1) return;

  fs.closeSync(out.fd);
  fs.renameSync(out.final + '.tmp', out.final);
  gzip(out.final);
}

/** Finalize and forget every open output whose day is before `minKeepDayNum`. */
function finalizeOlderThan(outs: Map<string, Out>, minKeepDayNum: number): void {
  for (const [day, out] of outs) {
    if (dayNum(day) >= minKeepDayNum) continue;

    finalize(out);
    outs.delete(day);
  }
}

/**
 * Compress `file` in place with a background `pigz` and return immediately —
 * the per-day loop is never blocked waiting on compression. Fire-and-forget:
 * a missing pigz or a failed run is tolerated (the plain CSV simply survives).
 * Not detached/unref'd, so node still waits for outstanding pigz at exit.
 */
function gzip(file: string): void {
  spawn('pigz', ['-np4', '--fast', file], { stdio: 'ignore' }).on('error', () => {});
}

/**
 * Stream one source file in fixed chunks and route each message to its
 * timestamp-day output. Consecutive lines bound for the same day are written as
 * one contiguous slice straight from the read buffer — no per-line copy — and
 * the run is flushed whenever the destination changes or a chunk ends. Returns
 * the number of messages read (== messages written for this file).
 */
function processFile(
  filePath:     string,
  timestampIdx: number,
  file:         SourceFile,
  getOut:       (day: string, fallbackInfix: string) => Out,
  outCnt:       Map<string, number>,
): number {
  const fileDayNum = dayNum(file.day);
  const fd  = fs.openSync(filePath, 'r');
  const buf = Buffer.allocUnsafe(CHUNK);

  let leftover = Buffer.alloc(0);
  let msgs     = 0;
  let curOut: Out | null = null; // destination of the run in progress

  // Only the source day and the day before it stay open; a message routed any
  // further back means the data is out of order or corrupt — crash, don't paper over it.
  const assertWindow = (destDay: string): void => {
    const behind = fileDayNum - dayNum(destDay);

    if (behind >= 2)
      throw new Error(
        `Rebucket window violation in ${file.name}: a message timestamped ${destDay} is ` +
        `${behind} days behind its source day ${file.day}. Only the source day and the day ` +
        `before are kept open — data this far out of order must be inspected.`,
      );
  };

  try {
    while (true) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);

      if (n === 0) break;

      const data = leftover.length ? Buffer.concat([leftover, buf.subarray(0, n)]) : buf.subarray(0, n);

      let pos      = 0;
      let runStart = -1; // start offset of the pending run for curOut, -1 if none

      const flush = (end: number): void => {
        if (runStart !== -1 && curOut && curOut.fd !== -1 && end > runStart)
          fs.writeSync(curOut.fd, data.subarray(runStart, end));

        runStart = -1;
      };

      let nl = data.indexOf(NL, pos);

      while (nl !== -1) {
        const lineStart = pos;

        pos = nl + 1;
        nl  = data.indexOf(NL, pos);

        const first = data[lineStart]!;

        if (first !== COMMA) {
          // Message-start line. Skip the repeated `_date_,…` header outright.
          if (first === UNDERSCORE && data.subarray(lineStart, lineStart + 6).toString() === '_date_') {
            flush(lineStart);
            continue;
          }

          msgs++;

          const destDay = dayOf(data, lineStart, timestampIdx);

          assertWindow(destDay);

          outCnt.set(destDay, (outCnt.get(destDay) ?? 0) + 1);

          const target = getOut(destDay, file.infix);

          if (target !== curOut) {
            flush(lineStart);
            curOut   = target;
            runStart = lineStart;
          } else if (runStart === -1) {
            runStart = lineStart;
          }
        } else if (curOut && runStart === -1) {
          // Continuation row: stays with the current message's run.
          runStart = lineStart;
        }
      }

      flush(pos);
      leftover = Buffer.from(data.subarray(pos));
    }

    // A final line with no trailing newline.
    if (leftover.length > 0) {
      const first = leftover[0]!;

      if (first !== COMMA && ! (first === UNDERSCORE && leftover.subarray(0, 6).toString() === '_date_')) {
        msgs++;

        const destDay = dayOf(leftover, 0, timestampIdx);

        assertWindow(destDay);

        outCnt.set(destDay, (outCnt.get(destDay) ?? 0) + 1);

        const target = getOut(destDay, file.infix);

        if (target.fd !== -1) fs.writeSync(target.fd, leftover);
      } else if (curOut && curOut.fd !== -1) {
        fs.writeSync(curOut.fd, leftover);
      }
    }
  } finally {
    fs.closeSync(fd);
  }

  return msgs;
}

/** The `YYYYMMDD` day of a message line at `start`, from its `timestamp` column. */
function dayOf(buf: Buffer, start: number, timestampIdx: number): string {
  let commas = 0;
  let i      = start;

  for (; i < buf.length; i++) {
    if (buf[i] === COMMA && ++commas === timestampIdx) break;
  }

  // `timestamp` begins at i+1 as `YYYY-MM-DD…`; fall back to the `_date_` column
  // (line start) for a timeless/empty value.
  const ts = buf.subarray(i + 1, i + 11).toString();

  if (ts.length === 10 && ts[4] === '-')
    return ts.slice(0, 4) + ts.slice(5, 7) + ts.slice(8, 10);

  const date = buf.subarray(start, start + 10).toString();

  return date.slice(0, 4) + date.slice(5, 7) + date.slice(8, 10);
}

// ── Reporting ──────────────────────────────────────────────────────────────────

function report(
  inCnt:    Map<string, number>,
  outCnt:   Map<string, number>,
  totalIn:  number,
  totalOut: number,
): void {
  section('Per-day counts (input → output)');

  const days = [...new Set([...inCnt.keys(), ...outCnt.keys()])].sort();

  for (const day of days) {
    const i     = inCnt.get(day) ?? 0;
    const o     = outCnt.get(day) ?? 0;
    const delta = o - i;
    const sign  = delta > 0 ? '+' : '';

    info(`${day}  in ${i.toLocaleString().padStart(12)}  out ${o.toLocaleString().padStart(12)}  Δ ${sign}${delta.toLocaleString()}`);
  }

  if (totalIn === totalOut)
    success(`Total — in ${totalIn.toLocaleString()} == out ${totalOut.toLocaleString()}`);
  else
    error(`COUNT MISMATCH — in ${totalIn.toLocaleString()} != out ${totalOut.toLocaleString()} (a message was lost or duplicated)`);
}

// ── Source discovery ────────────────────────────────────────────────────────────

const SOURCE_RE = /^(\d{8})\.(.+)\.csv$/;

/**
 * Source folders to process. If `root` itself holds `<day>.<infix>.csv` files
 * it is the one source; otherwise each immediate subdirectory that holds such
 * files is processed as an independent source (never crossed).
 */
function discoverSources(root: string): string[] {
  if (listSourceFiles(root).length > 0) return [root];

  return fs.readdirSync(root, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => path.join(root, e.name))
    .filter(d => listSourceFiles(d).length > 0)
    .sort();
}

/** Day-sorted `<day>.<infix>.csv` files in a folder, excluding our own output. */
function listSourceFiles(dir: string): SourceFile[] {
  return fs.readdirSync(dir)
    .map(name => {
      const m = SOURCE_RE.exec(name);

      return m ? { name, day: m[1]!, infix: m[2]! } : null;
    })
    .filter((f): f is SourceFile => f !== null && ! f.infix.endsWith('rebucketed'))
    .sort((a, b) => a.day.localeCompare(b.day));
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** First line of a file (without the trailing newline). */
function readFirstLine(filePath: string): string {
  const fd  = fs.openSync(filePath, 'r');
  const buf = Buffer.allocUnsafe(1 << 16);

  try {
    const n  = fs.readSync(fd, buf, 0, buf.length, null);
    const nl = buf.subarray(0, n).indexOf(NL);

    return buf.subarray(0, nl === -1 ? n : nl).toString();
  } finally {
    fs.closeSync(fd);
  }
}

/** Whole-day number (days since epoch, UTC) for a YYYYMMDD string. */
function dayNum(day: string): number {
  return Date.UTC(+day.slice(0, 4), +day.slice(4, 6) - 1, +day.slice(6, 8)) / 86_400_000;
}
