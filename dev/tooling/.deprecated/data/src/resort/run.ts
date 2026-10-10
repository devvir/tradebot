import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import type { Readable } from 'node:stream';
import { resolveCsvGzFiles, SUFFIXED_SOURCE_RE } from '../discover';
import { KNOWN_TABLES } from '../tables';
import { isDryRun } from '../options';
import { info, section, success, warn } from '../../../shared/ui/logger';
import type { FileResult, ResortTier, Stage } from './types';

/**
 * Re-sort collected (non-WS) buckets from symbol-major to timestamp-major, with
 * canonical ISO timestamps (`YYYY-MM-DDTHH:MM:SS.mmmZ`). Design and rationale in
 * `docs/tooling/DATA-RESORT.md`.
 *
 * Sources are flat CSVs (one line = one record) keyed by a `timestamp` column:
 * BitMEX public S3 daily buckets (symbol-major, `D`-separator microsecond
 * timestamps) and scribe REST buckets (`quote` symbol-major, `trade` already
 * time-sorted; canonical timestamps). WS-structured files (`_date_` first
 * column) are message-structured — continuation rows carry no timestamp, so
 * line-level sorting would tear messages apart — and are skipped outright.
 *
 * Never mutates the source: output is a sibling `<name>.resorted.csv.gz`,
 * written as `<name>.resorted.csv.gz.tmp` while in progress and renamed only
 * after the row-count invariant is verified by reading the finished artifact
 * back (which also proves gzip integrity). All intermediates — the `.tmp` and
 * the external sort's spill files — live in the source's own folder, visible
 * during the run and gone after it. Idempotent: files whose `.resorted` sibling
 * already exists are skipped, so re-running after an abort resumes cleanly.
 *
 * An up-front verdict pass (read-only, single streaming awk over the timestamp
 * column) classifies each file so no work is done when none is needed:
 * already-sorted-and-canonical files are clean-copied; sorted files with
 * non-canonical timestamps get a streaming normalize pass; only genuinely
 * unsorted files pay for the external sort. The verdict compares *normalized*
 * keys, so mixed fractional widths can't fake sortedness, and it fails fast on
 * the first out-of-order row. A malformed timestamp anywhere aborts the run
 * before anything is written — bad data is inspected, not papered over.
 *
 * Sorting is GNU `sort`'s external merge (`-S` caps memory, `-T` spills into
 * the working folder, `-s` keeps equal-timestamp rows in input order) under
 * `LC_ALL=C` — on canonical fixed-width timestamps, lexical order is
 * chronological. Everything is spawned directly (zcat/awk/sort/pigz piped in
 * Node) — no shell in the middle.
 */
export async function runResort(root: string): Promise<void> {
  const files = resolveCsvGzFiles(root, RESORT_TABLES)
    .filter(f => isResortCandidate(f, fs.existsSync));

  if (files.length === 0) {
    warn('No resort candidates found (nothing matched, or every file already has a .resorted sibling).');

    return;
  }

  section(`Resort — ${files.length} candidate file(s)${isDryRun() ? '  [dry-run]' : ''}`);

  const results: FileResult[] = [];

  for (const file of files) results.push(await resortFile(file));

  report(results);
}

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * Tables resort may be pointed at: the WS set plus the flat REST/S3 tables.
 * Passed to the shared discovery instead of `KNOWN_TABLES` so the extension is
 * local to resort — other subcommands' discovery is unchanged.
 */
const RESORT_TABLES: ReadonlySet<string> = new Set([
  ...KNOWN_TABLES,
  'trade', 'quote', 'compositeIndex',
]);

/** Memory cap handed to GNU sort (`-S`); beyond it, sorted runs spill to disk. */
const SORT_MEMORY = '1G';

/** Accepted source timestamp shape: date [D|T] time, optional fraction, optional Z. */
const TS_PATTERN =
  '^[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' +
  '[DT][0-9][0-9]:[0-9][0-9]:[0-9][0-9](\\.[0-9]+)?Z?$';

/**
 * Verdict pass: stream every data row, normalize its timestamp, and decide the
 * tier from two facts — did any timestamp change under normalization, and did
 * any normalized key sort below its predecessor. Exits early on the first
 * out-of-order row (the tier can only be `sort` from then on). Exit codes:
 * 0 = copy, 3 = normalize, 2 = sort, 4 = malformed timestamp (aborts the run).
 *
 * awk notes (POSIX-portable, mawk-safe): `exit` still runs END, so decisions
 * are flagged in the body and the exit code is chosen once, in END.
 */
const VERDICT_AWK = `
BEGIN { FS = "," }
NR == 1 { next }
{
  ts = $i

  if (ts !~ /${TS_PATTERN}/) { malformed = NR; exit }

  f = ""

  if (substr(ts, 20, 1) == ".") { f = substr(ts, 21); sub(/Z$/, "", f) }

  norm = substr(ts, 1, 10) "T" substr(ts, 12, 8) "." substr(f "000", 1, 3) "Z"

  if (norm != ts) changed = 1
  if (n > 0 && norm < prev) { disorder = NR; exit }

  prev = norm
  n++
}
END {
  if (malformed > 0) {
    printf "malformed timestamp at data line %d: %s\\n", malformed, ts > "/dev/stderr"
    exit 4
  }

  if (disorder > 0) exit 2

  exit changed ? 3 : 0
}
`;

/**
 * Normalize pass: rewrite the timestamp column of every data row to canonical
 * ISO (separator → `T`, fraction truncated/padded to 3 digits, `Z` appended).
 * The header is emitted only when `hdr` is set (the sort tier writes it to the
 * output directly, ahead of the sorted body). The data-row count is printed to
 * stderr for the in == out invariant. Exit 4 on a malformed timestamp.
 */
const NORMALIZE_AWK = `
BEGIN { FS = ","; OFS = "," }
NR == 1 { if (hdr) print; next }
{
  ts = $i

  if (ts !~ /${TS_PATTERN}/) { malformed = NR; bad = ts; exit }

  f = ""

  if (substr(ts, 20, 1) == ".") { f = substr(ts, 21); sub(/Z$/, "", f) }

  $i = substr(ts, 1, 10) "T" substr(ts, 12, 8) "." substr(f "000", 1, 3) "Z"

  rows++
  print
}
END {
  if (malformed > 0) {
    printf "malformed timestamp at data line %d: %s\\n", malformed, bad > "/dev/stderr"
    exit 4
  }

  printf "%d\\n", rows + 0 > "/dev/stderr"
}
`;

// ── Per-file pipeline ─────────────────────────────────────────────────────────

async function resortFile(file: string): Promise<FileResult> {
  const name   = path.basename(file);
  const header = await readFirstLineGz(file);
  const cols   = header.split(',');

  // WS-structured files are message-shaped (continuation rows carry no
  // timestamp); line-level sorting would tear messages apart. Never touch them.
  if (cols[0] === '_date_') {
    warn(`${name} — WS-structured source (_date_ column); resort handles flat tables only. Skipped.`);

    return { file: name, tier: 'skipped', rows: null };
  }

  const tsIdx = cols.indexOf('timestamp');

  if (tsIdx === -1) {
    warn(`${name} — no timestamp column in the header. Skipped.`);

    return { file: name, tier: 'skipped', rows: null };
  }

  const tier = await verdict(file, tsIdx);

  info(`${name} — ${TIER_LABELS[tier]}`);

  if (isDryRun()) return { file: name, tier, rows: null };

  const out = resortOutputPath(file);
  const tmp = out + '.tmp';

  try {
    let rows: number | null = null;

    if (tier === 'copy') {
      copyVerbatim(file, tmp);
    } else {
      rows = tier === 'normalize'
        ? await normalizeInto(file, tmp, tsIdx)
        : await sortInto(file, tmp, tsIdx, header);

      await verifyRowCount(tmp, rows);
    }

    fs.renameSync(tmp, out);

    return { file: name, tier, rows };
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* best effort */ }

    throw new Error(`${name}: ${(err as Error).message}`);
  }
}

/** Classify a file by streaming its timestamp column through the verdict awk. */
async function verdict(file: string, tsIdx: number): Promise<ResortTier> {
  const zcat = stage('zcat', [file]);
  const awk  = stage('awk', ['-v', `i=${tsIdx + 1}`, VERDICT_AWK]);

  zcat.child.stdout!.pipe(awk.child.stdin!);

  const stderr = collectStream(awk.child.stderr!);
  const code   = await awk.exit;

  // On the early-exit verdicts (2/4) zcat may still be streaming into a closed
  // pipe — kill it; its exit status is meaningless there. But when awk consumed
  // the whole stream (0/3), zcat's status is the proof the stream was complete:
  // a zcat that died mid-file would truncate the input and could misclassify an
  // unsorted file as copy/normalize, so a non-zero exit must abort loudly.
  zcat.child.kill('SIGTERM');

  const zcatCode = await zcat.exit;

  if ((code === 0 || code === 3) && zcatCode !== 0) {
    throw new Error(`verdict read a truncated stream (zcat exited with code ${zcatCode})`);
  }

  switch (code) {
    case 0: return 'copy';
    case 3: return 'normalize';
    case 2: return 'sort';
    case 4: throw new Error((await stderr).trim() || 'malformed timestamp');
    default: throw new Error(`verdict pass failed (awk exit ${code})`);
  }
}

/** Tier `copy`: the source is already the desired artifact — duplicate it byte-for-byte. */
function copyVerbatim(file: string, tmp: string): void {
  fs.copyFileSync(file, tmp);

  const src = fs.statSync(file).size;
  const dst = fs.statSync(tmp).size;

  if (src !== dst) throw new Error(`copy size mismatch: source ${src} B, copy ${dst} B`);
}

/**
 * Tier `normalize`: stream zcat → awk (header + normalized rows, order
 * untouched) → pigz → `.tmp`. Returns the data-row count reported by awk.
 */
async function normalizeInto(file: string, tmp: string, tsIdx: number): Promise<number> {
  const outFd = fs.openSync(tmp, 'w');

  try {
    const zcat = stage('zcat', [file]);
    const awk  = stage('awk', ['-v', `i=${tsIdx + 1}`, '-v', 'hdr=1', NORMALIZE_AWK]);
    const pigz = stage('pigz', ['-p4'], { stdio: ['pipe', outFd, 'inherit'] });

    zcat.child.stdout!.pipe(awk.child.stdin!);
    awk.child.stdout!.pipe(pigz.child.stdin!);

    const stderr = collectStream(awk.child.stderr!);

    await assertExitsWithDiagnostics({ zcat, awk, pigz }, stderr);

    return parseRowCount(await stderr);
  } finally {
    fs.closeSync(outFd);
  }
}

/**
 * Tier `sort`: the header goes straight to pigz, then the body streams
 * zcat → awk (normalize, header dropped) → GNU sort (external merge, stable,
 * spill in the source's folder, LC_ALL=C so lexical == chronological on the
 * canonical keys) → pigz → `.tmp`. Returns the data-row count from awk.
 */
async function sortInto(file: string, tmp: string, tsIdx: number, header: string): Promise<number> {
  const outFd = fs.openSync(tmp, 'w');

  try {
    const key  = `${tsIdx + 1},${tsIdx + 1}`;
    const zcat = stage('zcat', [file]);
    const awk  = stage('awk', ['-v', `i=${tsIdx + 1}`, '-v', 'hdr=0', NORMALIZE_AWK]);
    const sort = stage(
      'sort', ['-t', ',', '-k', key, '-s', '-S', SORT_MEMORY, '-T', path.dirname(file)],
      { stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, LC_ALL: 'C' } },
    );
    const pigz = stage('pigz', ['-p4'], { stdio: ['pipe', outFd, 'inherit'] });

    pigz.child.stdin!.write(header + '\n');

    zcat.child.stdout!.pipe(awk.child.stdin!);
    awk.child.stdout!.pipe(sort.child.stdin!);
    sort.child.stdout!.pipe(pigz.child.stdin!);

    const stderr = collectStream(awk.child.stderr!);

    try {
      await assertExitsWithDiagnostics({ zcat, awk, sort, pigz }, stderr);
    } catch (err) {
      cleanSortSpills(path.dirname(file));

      throw err;
    }

    return parseRowCount(await stderr);
  } finally {
    fs.closeSync(outFd);
  }
}

/**
 * Sweep GNU sort's spill files (`sortXXXXXX`, mkstemp pattern) after a failed
 * sort tier. sort cleans them itself on SIGTERM, but a SIGKILL'd sort (the OOM
 * killer's signal) can't — and on an unattended cron those multi-GB leftovers
 * would silently accumulate in the vault folder run after run. Best effort;
 * assumes no concurrent resort is spilling into the same folder (resort is
 * sequential within a run).
 */
function cleanSortSpills(dir: string): void {
  for (const name of fs.readdirSync(dir)) {
    if (! /^sort[A-Za-z0-9]{6}$/.test(name)) continue;

    try { fs.unlinkSync(path.join(dir, name)); } catch { /* best effort */ }
  }
}

/**
 * Read the finished artifact back and check the row-count invariant:
 * total lines == header + expected data rows. Decompressing the whole file
 * also proves gzip integrity — this verifies the actual deliverable on disk.
 */
async function verifyRowCount(tmp: string, expectedRows: number): Promise<void> {
  const zcat = stage('zcat', [tmp]);
  const wc   = stage('wc', ['-l']);

  zcat.child.stdout!.pipe(wc.child.stdin!);

  const out = collectStream(wc.child.stdout!);

  await assertExits({ zcat, wc });

  const lines = parseInt((await out).trim(), 10);

  if (lines !== expectedRows + 1) {
    throw new Error(
      `row-count mismatch: output has ${lines - 1} data rows, expected ${expectedRows} — a row was lost or duplicated`,
    );
  }
}

// ── File selection ────────────────────────────────────────────────────────────

/**
 * A `.csv.gz` file is a resort candidate when it is a suffixed source
 * (`YYYYMMDD.<suffix>.csv.gz` — sources always carry a source suffix; plain
 * `YYYYMMDD.csv.gz` files are built buckets), is not itself a
 * `.resorted.csv.gz` output, and has not already been resorted (no sibling
 * output exists). `exists` is injected for testing.
 */
function isResortCandidate(filePath: string, exists: (p: string) => boolean): boolean {
  const name = path.basename(filePath);

  if (! SUFFIXED_SOURCE_RE.test(name))          return false;
  if (filePath.endsWith('.resorted.csv.gz'))    return false;
  if (exists(resortOutputPath(filePath)))       return false;

  return true;
}

function resortOutputPath(filePath: string): string {
  return filePath.replace(/\.csv\.gz$/, '.resorted.csv.gz');
}

// ── Reporting ─────────────────────────────────────────────────────────────────

const TIER_LABELS: Record<string, string> = {
  copy:      'already sorted & canonical → clean copy',
  normalize: 'sorted, non-canonical timestamps → normalize',
  sort:      'not timestamp-sorted → normalize + sort',
  skipped:   'skipped',
};

function report(results: FileResult[]): void {
  section('Resort results');

  for (const r of results) {
    const rows = r.rows === null ? '' : `  ${r.rows.toLocaleString()} rows`;

    info(`${r.file}  ${r.tier}${rows}`);
  }

  const counts = new Map<string, number>();

  for (const r of results) counts.set(r.tier, (counts.get(r.tier) ?? 0) + 1);

  const summary = ['copy', 'normalize', 'sort', 'skipped']
    .filter(t => counts.has(t))
    .map(t => `${counts.get(t)} ${t}`)
    .join(', ');

  const verified = isDryRun()
    ? 'Dry-run — nothing written.'
    : 'All written outputs verified (row counts match).';

  success(`${results.length} file(s) — ${summary}. ${verified}`);
}

// ── Process helpers ───────────────────────────────────────────────────────────

/**
 * Spawn a pipeline stage. The exit promise is created here, at spawn time —
 * attaching the listener later would miss stages that finish before the
 * pipeline is fully assembled (tiny inputs; the original hang). EPIPE on the
 * stage's own pipes is swallowed: a downstream stage exiting early (verdict
 * fast-fail) must not crash the process — real failures surface via exit codes.
 *
 * The promise resolves on `exit`, NOT `close`: `close` additionally waits for
 * the child's stdio streams to end, and a stage whose downstream died early
 * (verdict fast-fail) leaves its stdout paused with unconsumed buffered data —
 * `close` then never fires, the await never settles, the event loop drains,
 * and the whole run silently exits 0 mid-loop. Exit codes are all the callers
 * consume here; stream completeness is proven separately (collectStream `end`,
 * and the read-back row-count verification of the written artifact).
 */
function stage(cmd: string, args: string[], opts?: Parameters<typeof spawn>[2]): Stage {
  const child = spawn(cmd, args, opts ?? { stdio: ['pipe', 'pipe', 'pipe'] });

  child.stdin?.on('error', () => { /* surfaced via exit codes */ });
  child.stdout?.on('error', () => { /* surfaced via exit codes */ });

  const exit = new Promise<number | null>(resolve => {
    child.once('error', () => resolve(null)); // spawn failure (e.g. missing binary)
    child.once('exit', code => resolve(code));
  });

  return { child, exit };
}

/**
 * Await every stage, failing FAST on the first non-zero exit.
 *
 * Fail-fast is load-bearing, not a nicety: when a mid-pipeline stage dies
 * (OOM-killed sort, failed pigz), its stdin's EPIPE is swallowed by `stage()`
 * and the upstream process is left blocked writing into a dead pipe — it will
 * never exit on its own. Waiting for *all* exits before checking any code
 * (the previous shape) therefore deadlocked the whole run silently, with the
 * real failure never reported. Instead, the first non-zero (or spawn-failure
 * `null`) exit kills every other stage — unblocking the stuck writers — and
 * throws naming the culprit, so the failure is loud and the process exits 1.
 */
async function assertExits(stages: Record<string, Stage>): Promise<void> {
  const names = Object.keys(stages);
  const list  = Object.values(stages);

  const failure = await Promise.race([
    Promise.all(list.map(s => s.exit)).then(() => null),

    ...list.map((s, i) => s.exit.then(code =>
      code === 0
        ? new Promise<never>(() => { /* success — let the others decide */ })
        : { name: names[i]!, code },
    )),
  ]);

  if (! failure) return;

  // SIGTERM, not SIGKILL: every stage here dies promptly on it, and GNU sort
  // removes its own spill files on SIGTERM (SIGKILL would leak them).
  for (const s of list) s.child.kill('SIGTERM');

  throw new Error(`${failure.name} exited with code ${failure.code}`);
}

/**
 * `assertExits`, with awk's stderr appended to the failure. The interesting
 * failures (exit 4: malformed timestamp) explain themselves on stderr; without
 * this the error would only name the stage and code. The stream has ended by
 * the time the failure is thrown (every stage is dead), so the await is safe;
 * a collect error just degrades to the plain message.
 */
async function assertExitsWithDiagnostics(
  stages: Record<string, Stage>,
  stderr: Promise<string>,
): Promise<void> {
  try {
    await assertExits(stages);
  } catch (err) {
    const diag = await stderr.then(s => s.trim(), () => '');

    throw new Error(diag ? `${(err as Error).message} — ${diag}` : (err as Error).message);
  }
}

function collectStream(stream: Readable): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';

    stream.on('data', chunk => { data += chunk; });
    stream.once('end', () => resolve(data));
    stream.once('error', reject);
  });
}

/** Last line of awk's stderr is the data-row count (earlier lines are diagnostics). */
function parseRowCount(stderr: string): number {
  const lines = stderr.trim().split('\n');
  const count = parseInt(lines[lines.length - 1]!, 10);

  if (Number.isNaN(count)) throw new Error(`could not parse row count from awk output: "${stderr.trim()}"`);

  return count;
}

/** First line of a gzipped file, decompressed incrementally — never inflates the whole file. */
function readFirstLineGz(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stream = fs.createReadStream(file);
    const gunzip = zlib.createGunzip();

    let buf     = '';
    let settled = false;

    const finish = (err: Error | null, line?: string): void => {
      if (settled) return;

      settled = true;
      stream.destroy();
      gunzip.destroy();

      if (err) reject(err); else resolve(line!);
    };

    gunzip.on('data', (chunk: Buffer) => {
      const s  = chunk.toString('utf8');
      const nl = s.indexOf('\n');

      if (nl === -1) {
        buf += s;

        if (buf.length > 1 << 20) finish(new Error(`no newline in the first MiB of ${path.basename(file)}`));

        return;
      }

      finish(null, buf + s.slice(0, nl));
    });

    gunzip.once('end', () => finish(null, buf)); // header-only file without trailing newline
    gunzip.once('error', err => finish(err));
    stream.once('error', err => finish(err));
    stream.pipe(gunzip);
  });
}

// ── Test-only exports ─────────────────────────────────────────────────────────

export const _test_isResortCandidate = isResortCandidate;
export const _test_resortOutputPath  = resortOutputPath;
export const _test_readFirstLineGz   = readFirstLineGz;
export const _test_stage             = stage;
