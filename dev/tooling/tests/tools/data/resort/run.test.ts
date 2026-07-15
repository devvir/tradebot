import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  runResort,
  _test_isResortCandidate,
  _test_resortOutputPath,
  _test_readFirstLineGz,
  _test_stage,
} from '../../../../src/tools/data/resort/run';
import { setDryRun, setFromDay } from '../../../../src/tools/data/options';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const QUOTE_HEADER = 'timestamp,symbol,bidSize,bidPrice,askPrice,askSize';

/** Write a gzipped CSV under `<base>/quote/2026/<name>` and return its path. */
function writeGz(base: string, name: string, lines: string[]): string {
  const dir = path.join(base, 'quote', '2026');

  fs.mkdirSync(dir, { recursive: true });

  const file = path.join(dir, name);

  fs.writeFileSync(file, zlib.gzipSync(lines.join('\n') + '\n'));

  return file;
}

function readGz(file: string): string[] {
  return zlib.gunzipSync(fs.readFileSync(file)).toString('utf8').trimEnd().split('\n');
}

/** The path resort is pointed at for fixtures written by `writeGz`. */
function quoteYearDir(base: string): string {
  return path.join(base, 'quote', '2026');
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('data resort', () => {
  let base: string;

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'resort-test-'));
    setDryRun(false);
    setFromDay(null);
  });

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  // ── Tier: copy ──────────────────────────────────────────────────────────────

  it('clean-copies a file that is already sorted and canonical', async () => {
    const src = writeGz(base, '20260101.primary.csv.gz', [
      QUOTE_HEADER,
      '2026-01-01T00:00:00.100Z,AAA,1,10,11,1',
      '2026-01-01T00:00:00.200Z,BBB,2,20,21,2',
      '2026-01-01T00:00:00.300Z,AAA,3,10,11,3',
    ]);

    await runResort(quoteYearDir(base));

    const out = _test_resortOutputPath(src);

    expect(fs.existsSync(out)).toBe(true);
    expect(fs.readFileSync(out)).toEqual(fs.readFileSync(src)); // byte-identical
  });

  // ── Tier: normalize ─────────────────────────────────────────────────────────

  it('normalizes a sorted S3-format file without reordering', async () => {
    const src = writeGz(base, '20260102.aggregated.csv.gz', [
      QUOTE_HEADER,
      '2026-01-02D00:00:00.100999,AAA,1,10,11,1',
      '2026-01-02D00:00:00.200500,BBB,2,20,21,2',
      '2026-01-02D01:02:03.999999,AAA,3,10,11,3',
    ]);

    await runResort(quoteYearDir(base));

    expect(readGz(_test_resortOutputPath(src))).toEqual([
      QUOTE_HEADER,
      '2026-01-02T00:00:00.100Z,AAA,1,10,11,1', // micros truncated, D→T, Z added
      '2026-01-02T00:00:00.200Z,BBB,2,20,21,2',
      '2026-01-02T01:02:03.999Z,AAA,3,10,11,3',
    ]);
  });

  it('pads short fractions and handles missing fractions', async () => {
    const src = writeGz(base, '20260103.x.csv.gz', [
      QUOTE_HEADER,
      '2026-01-03D00:00:01,AAA,1,10,11,1',
      '2026-01-03D00:00:02.5,BBB,2,20,21,2',
    ]);

    await runResort(quoteYearDir(base));

    expect(readGz(_test_resortOutputPath(src))).toEqual([
      QUOTE_HEADER,
      '2026-01-03T00:00:01.000Z,AAA,1,10,11,1',
      '2026-01-03T00:00:02.500Z,BBB,2,20,21,2',
    ]);
  });

  // ── Tier: sort ──────────────────────────────────────────────────────────────

  it('re-sorts a symbol-major canonical file to timestamp order', async () => {
    const src = writeGz(base, '20260104.primary.csv.gz', [
      QUOTE_HEADER,
      // symbol-major: AAA block then BBB block, interleaved in time
      '2026-01-04T00:00:00.100Z,AAA,1,10,11,1',
      '2026-01-04T00:00:00.300Z,AAA,2,10,11,2',
      '2026-01-04T00:00:00.200Z,BBB,3,20,21,3',
      '2026-01-04T00:00:00.400Z,BBB,4,20,21,4',
    ]);

    await runResort(quoteYearDir(base));

    expect(readGz(_test_resortOutputPath(src))).toEqual([
      QUOTE_HEADER,
      '2026-01-04T00:00:00.100Z,AAA,1,10,11,1',
      '2026-01-04T00:00:00.200Z,BBB,3,20,21,3',
      '2026-01-04T00:00:00.300Z,AAA,2,10,11,2',
      '2026-01-04T00:00:00.400Z,BBB,4,20,21,4',
    ]);
  });

  it('re-sorts a symbol-major S3-format file, normalizing timestamps', async () => {
    const src = writeGz(base, '20260105.aggregated.csv.gz', [
      QUOTE_HEADER,
      '2026-01-05D00:00:00.300100,AAA,1,10,11,1',
      '2026-01-05D00:00:00.100200,BBB,2,20,21,2',
    ]);

    await runResort(quoteYearDir(base));

    expect(readGz(_test_resortOutputPath(src))).toEqual([
      QUOTE_HEADER,
      '2026-01-05T00:00:00.100Z,BBB,2,20,21,2',
      '2026-01-05T00:00:00.300Z,AAA,1,10,11,1',
    ]);
  });

  it('keeps equal-timestamp rows in input order (stable sort)', async () => {
    const src = writeGz(base, '20260106.primary.csv.gz', [
      QUOTE_HEADER,
      '2026-01-06T00:00:00.500Z,AAA,1,10,11,1',
      '2026-01-06T00:00:00.100Z,BBB,2,20,21,2',
      '2026-01-06T00:00:00.100Z,CCC,3,30,31,3', // same ms as BBB, after it
    ]);

    await runResort(quoteYearDir(base));

    expect(readGz(_test_resortOutputPath(src))).toEqual([
      QUOTE_HEADER,
      '2026-01-06T00:00:00.100Z,BBB,2,20,21,2',
      '2026-01-06T00:00:00.100Z,CCC,3,30,31,3',
      '2026-01-06T00:00:00.500Z,AAA,1,10,11,1',
    ]);
  });

  it('detects disorder only visible after normalization (mixed fraction widths)', async () => {
    // Raw-lexical order says sorted ("...1.15" < "...1.2"), but chronologically
    // .15 < .2 is FINE... use a case where raw says sorted and normalized says not:
    // "00:00:01.5" (=.500) vs "00:00:01.100" — raw: "1.100Z" < "1.5" (sorted),
    // normalized: .500 then .100 (unsorted).
    const src = writeGz(base, '20260107.x.csv.gz', [
      QUOTE_HEADER,
      '2026-01-07D00:00:01.100,AAA,1,10,11,1',
      '2026-01-07D00:00:01.5,BBB,2,20,21,2',
      '2026-01-07D00:00:01.200,CCC,3,30,31,3',
    ]);

    await runResort(quoteYearDir(base));

    expect(readGz(_test_resortOutputPath(src))).toEqual([
      QUOTE_HEADER,
      '2026-01-07T00:00:01.100Z,AAA,1,10,11,1',
      '2026-01-07T00:00:01.200Z,CCC,3,30,31,3',
      '2026-01-07T00:00:01.500Z,BBB,2,20,21,2',
    ]);
  });

  it('survives the verdict fast-fail race (early disorder, large buffered tail)', async () => {
    // The shape that exposed the silent mid-loop exit in production: the
    // verdict awk fast-fails on the first out-of-order row while zcat still
    // has thousands of unconsumed rows buffered. The deterministic regression
    // for the underlying stage-exit hang is the `_test_stage` test below.
    const rows = ['2026-01-16T00:00:01.000Z,AAA,1,10,11,1'];

    for (let n = 0; n < 5000; n++) {
      const ms = String(n % 1000).padStart(3, '0');
      const s  = String(Math.floor(n / 1000)).padStart(2, '0');

      rows.push(`2026-01-16T00:00:${s}.${ms}Z,BBB,2,20,21,2`); // row 2 is out of order vs row 1
    }

    const src = writeGz(base, '20260116.primary.csv.gz', [QUOTE_HEADER, ...rows]);

    await runResort(quoteYearDir(base));

    const out = readGz(_test_resortOutputPath(src));

    expect(out).toHaveLength(5002);
    expect([...out.slice(1)].sort()).toEqual(out.slice(1)); // fully time-sorted
  }, 15000);

  // ── Skips & guards ──────────────────────────────────────────────────────────

  it('skips files whose .resorted sibling already exists', async () => {
    const src = writeGz(base, '20260108.primary.csv.gz', [
      QUOTE_HEADER,
      '2026-01-08T00:00:00.100Z,AAA,1,10,11,1',
    ]);
    const out = _test_resortOutputPath(src);

    fs.writeFileSync(out, zlib.gzipSync('sentinel\n'));

    await runResort(quoteYearDir(base));

    expect(zlib.gunzipSync(fs.readFileSync(out)).toString()).toBe('sentinel\n'); // untouched
  });

  it('never processes its own .resorted outputs', async () => {
    const src = writeGz(base, '20260109.primary.csv.gz', [
      QUOTE_HEADER,
      '2026-01-09T00:00:00.100Z,AAA,1,10,11,1',
    ]);

    await runResort(quoteYearDir(base));
    await runResort(quoteYearDir(base)); // second run: source skipped (sibling exists), output not a candidate

    const files = fs.readdirSync(path.dirname(src)).sort();

    expect(files).toEqual(['20260109.primary.csv.gz', '20260109.primary.resorted.csv.gz']);
  });

  it('skips WS-structured files (_date_ first column)', async () => {
    const src = writeGz(base, '20260110.local.csv.gz', [
      '_date_,_action_,symbol,timestamp',
      '2026-01-10T00:00:00.100Z,insert,AAA,2026-01-10T00:00:00.050Z',
      ',,BBB,',
    ]);

    await runResort(quoteYearDir(base));

    expect(fs.existsSync(_test_resortOutputPath(src))).toBe(false);
  });

  it('skips files without a timestamp column', async () => {
    const src = writeGz(base, '20260111.x.csv.gz', [
      'symbol,price',
      'AAA,10',
    ]);

    await runResort(quoteYearDir(base));

    expect(fs.existsSync(_test_resortOutputPath(src))).toBe(false);
  });

  it('dry-run writes nothing', async () => {
    const src = writeGz(base, '20260112.primary.csv.gz', [
      QUOTE_HEADER,
      '2026-01-12T00:00:00.200Z,AAA,1,10,11,1',
      '2026-01-12T00:00:00.100Z,BBB,2,20,21,2',
    ]);

    setDryRun(true);

    await runResort(quoteYearDir(base));

    expect(fs.existsSync(_test_resortOutputPath(src))).toBe(false);
    expect(fs.readdirSync(path.dirname(src))).toEqual(['20260112.primary.csv.gz']); // no .tmp either
  });

  // ── Failure modes ───────────────────────────────────────────────────────────

  it('aborts on a malformed timestamp, leaving no output or .tmp', async () => {
    const src = writeGz(base, '20260113.primary.csv.gz', [
      QUOTE_HEADER,
      '2026-01-13T00:00:00.100Z,AAA,1,10,11,1',
      'not-a-timestamp,BBB,2,20,21,2',
    ]);

    await expect(runResort(quoteYearDir(base))).rejects.toThrow(/malformed timestamp/);

    const files = fs.readdirSync(path.dirname(src));

    expect(files).toEqual(['20260113.primary.csv.gz']); // no output, no .tmp
  });

  it('aborts on an empty timestamp field', async () => {
    writeGz(base, '20260114.primary.csv.gz', [
      QUOTE_HEADER,
      ',AAA,1,10,11,1',
    ]);

    await expect(runResort(quoteYearDir(base))).rejects.toThrow(/malformed timestamp/);
  });

  // ── Unit: helpers ───────────────────────────────────────────────────────────

  it('isResortCandidate excludes outputs, already-resorted sources, and non-suffixed buckets', () => {
    const no = new Set<string>();
    const src = '/x/quote/2026/20260101.primary.csv.gz';

    expect(_test_isResortCandidate(src, p => no.has(p))).toBe(true);
    expect(_test_isResortCandidate('/x/quote/2026/20260101.primary.resorted.csv.gz', p => no.has(p))).toBe(false);
    expect(_test_isResortCandidate('/x/quote/2026/20260101.csv.gz', p => no.has(p))).toBe(false); // built bucket, not a source

    const done = new Set(['/x/quote/2026/20260101.primary.resorted.csv.gz']);

    expect(_test_isResortCandidate(src, p => done.has(p))).toBe(false);
  });

  it('stage exit promise settles without waiting for stdio drainage', async () => {
    // Regression: a stage whose downstream died early (verdict fast-fail)
    // exits with its stdout still holding undrained data — the child's
    // `close` event is withheld in that state. When the exit promise resolved
    // on `close`, `await stage.exit` never settled, the event loop drained,
    // and the whole run silently exited 0 mid-loop, mimicking completion.
    // Deterministic stand-in for that state: a grandchild inheriting stdout
    // keeps the pipe open long after the stage itself exited, so `close`
    // cannot fire within the test timeout. Resolving on `exit` must settle
    // immediately regardless; under the old `close`-based code this times out.
    const s = _test_stage('sh', ['-c', 'sleep 30 & exit 0']);

    expect(await s.exit).toBe(0);

    s.child.stdout!.destroy(); // release the orphan's pipe reference in the parent
  }, 5000);

  it('readFirstLineGz returns the header of a gzipped file', async () => {
    const src = writeGz(base, '20260115.primary.csv.gz', [
      QUOTE_HEADER,
      '2026-01-15T00:00:00.100Z,AAA,1,10,11,1',
    ]);

    expect(await _test_readFirstLineGz(src)).toBe(QUOTE_HEADER);
  });
});
