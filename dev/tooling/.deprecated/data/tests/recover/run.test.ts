import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import {
  _test_isCorrupt,
  _test_lastTimestampOffset,
  _test_pruneScrambledTail,
  _test_recoverFile,
  _test_rowSpec,
  _test_sanitize,
  _test_validMessage,
  _test_validRow,
} from '../../../../src/tools/data/recover/run';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const HEADER = '_date_,_action_,symbol\n';
const row    = (ts: string) => `${ts},delete,XBTUSD\n`;

/** gzrecover is from the `gzrt` package — not universally installed. */
function hasGzrecover(): boolean {
  try {
    execFileSync('which', ['gzrecover'], { stdio: 'ignore' });

    return true;
  } catch {
    return false;
  }
}

let dir: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sources-recover-'));
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── isCorrupt ─────────────────────────────────────────────────────────────────

describe('isCorrupt', () => {
  it('returns false for a valid gzip', async () => {
    const p = path.join(dir, 'valid.csv.gz');

    fs.writeFileSync(p, zlib.gzipSync(HEADER + row('2026-01-01T00:00:00.000Z')));

    expect(await _test_isCorrupt(p)).toBe(false);
  });

  it('returns true for a truncated gzip', async () => {
    const p    = path.join(dir, 'corrupt.csv.gz');
    const good = zlib.gzipSync((HEADER + row('2026-01-01T00:00:00.000Z')).repeat(100));

    // Chopping the 8-byte CRC + ISIZE trailer makes `gzip -t` fail.
    fs.writeFileSync(p, good.subarray(0, good.length - 8));

    expect(await _test_isCorrupt(p)).toBe(true);
  });
});

// ── lastTimestampOffset ───────────────────────────────────────────────────────

describe('lastTimestampOffset', () => {
  it('returns the byte offset where the last timestamped line starts', async () => {
    const r1 = row('2026-04-11T00:00:00.020Z');
    const r2 = row('2026-04-11T00:00:01.500Z');
    const p  = path.join(dir, 'offset.csv');

    fs.writeFileSync(p, HEADER + r1 + r2);

    expect(await _test_lastTimestampOffset(p)).toBe(Buffer.byteLength(HEADER + r1));
  });

  it('returns null when no line starts with a timestamp', async () => {
    const p = path.join(dir, 'no-ts.csv');

    fs.writeFileSync(p, HEADER + ',,XBTUSD\n');   // header + empty `_date_` row

    expect(await _test_lastTimestampOffset(p)).toBeNull();
  });
});

// ── pruneScrambledTail ────────────────────────────────────────────────────────

describe('pruneScrambledTail', () => {
  it('drops the last timestamped row and the scrambled bytes after it', async () => {
    const r1        = row('2026-04-11T00:00:00.020Z');
    const r2partial = '2026-04-11T00:00:01.500Z,delete';   // valid prefix, no newline
    // Garbage with an embedded newline — proves grep line-splitting over the
    // binary tail still picks the real last timestamp line, not a fragment.
    const garbage   = Buffer.from([0x00, 0xff, 0x9d, 0x0a, 0x88, 0x12]);
    const p         = path.join(dir, 'garbage-tail.csv');

    fs.writeFileSync(p, Buffer.concat([Buffer.from(HEADER + r1 + r2partial), garbage]));

    expect(await _test_pruneScrambledTail(p)).toBe('pruned');
    expect(fs.readFileSync(p, 'utf8')).toBe(HEADER + r1);
  });

  it('still drops the final row when the file has no garbage tail', async () => {
    // pruneScrambledTail only runs on already-corrupt files; the last row sits
    // on the corruption boundary and is dropped — the accepted tradeoff.
    const r1 = row('2026-04-11T00:00:00.020Z');
    const r2 = row('2026-04-11T00:00:01.500Z');
    const p  = path.join(dir, 'clean-tail.csv');

    fs.writeFileSync(p, HEADER + r1 + r2);

    expect(await _test_pruneScrambledTail(p)).toBe('pruned');
    expect(fs.readFileSync(p, 'utf8')).toBe(HEADER + r1);
  });

  it('leaves the file untouched when no timestamp is found', async () => {
    const content = HEADER + ',,XBTUSD\n';
    const p       = path.join(dir, 'untouched.csv');

    fs.writeFileSync(p, content);

    expect(await _test_pruneScrambledTail(p)).toBe('no-timestamp');
    expect(fs.readFileSync(p, 'utf8')).toBe(content);
  });
});

// ── validRow / validMessage ───────────────────────────────────────────────────

// Layout: `_date_, _action_, symbol, timestamp` — `_date_` at 0, `timestamp` at 3.
const SPEC = _test_rowSpec(['_date_', '_action_', 'symbol', 'timestamp']);

const TS = '2026-04-11T00:00:00.020Z';

describe('validRow', () => {
  it('accepts a healthy first row', () => {
    expect(_test_validRow(`${TS},update,XBTUSD,${TS}`, true, SPEC)).toBe(true);
  });

  it('accepts a healthy continuation row (empty _date_)', () => {
    expect(_test_validRow(`,,ETHUSD,${TS}`, false, SPEC)).toBe(true);
  });

  it('rejects a non-ASCII byte', () => {
    expect(_test_validRow(`${TS},update,XB\xffSD,${TS}`, true, SPEC)).toBe(false);
  });

  it('rejects a wrong column count', () => {
    expect(_test_validRow(`${TS},update,XBTUSD,${TS},extra`, true, SPEC)).toBe(false);
  });

  it('rejects a first row whose _date_ is not ISO', () => {
    expect(_test_validRow(`garbage,update,XBTUSD,${TS}`, true, SPEC)).toBe(false);
  });

  it('rejects a continuation row whose _date_ is non-empty', () => {
    expect(_test_validRow(`${TS},,ETHUSD,${TS}`, false, SPEC)).toBe(false);
  });

  it('rejects a row with a non-ISO timestamp', () => {
    expect(_test_validRow(`${TS},update,XBTUSD,nope`, true, SPEC)).toBe(false);
  });
});

describe('validMessage', () => {
  it('accepts a multi-row message when every row is healthy', () => {
    expect(_test_validMessage([`${TS},update,XBTUSD,${TS}`, `,,ETHUSD,${TS}`], SPEC)).toBe(true);
  });

  it('rejects the whole message when any continuation row is garbage', () => {
    expect(_test_validMessage([`${TS},update,XBTUSD,${TS}`, `,,ET\x00SD,${TS}`], SPEC)).toBe(false);
  });
});

// ── sanitize (post-gzrecover) ─────────────────────────────────────────────────

describe('sanitize', () => {
  it('drops a garbage-corrupted message in the middle and keeps the healthy ones', async () => {
    const header = '_date_,_action_,symbol,timestamp\n';
    const m1     = `2026-04-11T00:00:00.000Z,update,XBTUSD,2026-04-11T00:00:00.000Z\n`;
    // healthy multi-row message (first row + one continuation)
    const m2     = `2026-04-11T00:00:01.000Z,update,XBTUSD,2026-04-11T00:00:01.000Z\n,,ETHUSD,2026-04-11T00:00:01.000Z\n`;
    const m4     = `2026-04-11T00:00:03.000Z,update,SOLUSD,2026-04-11T00:00:03.000Z\n`;

    // A corrupt member boundary: binary garbage with an embedded newline, so it
    // splits into bad "lines" sitting between the healthy messages.
    const garbage = Buffer.from([0x00, 0xff, 0x9d, 0x0a, 0x88, 0x12, 0x0a]);

    const inPath  = path.join(dir, 'sanitize-in.csv');
    const outPath = path.join(dir, 'sanitize-out.csv');

    fs.writeFileSync(inPath, Buffer.concat([
      Buffer.from(header + m1 + m2), garbage, Buffer.from(m4),
    ]));

    const stats = await _test_sanitize(inPath, outPath, SPEC);

    // header passes through; m1, m2, m4 kept; the garbage message dropped.
    expect(fs.readFileSync(outPath, 'utf8')).toBe(header + m1 + m2 + m4);
    expect(stats.msgKept).toBe(3);
    expect(stats.rowsKept).toBe(4);          // m1(1) + m2(2) + m4(1)
    expect(stats.msgDropped).toBeGreaterThan(0);
    expect(stats.rowsDropped).toBeGreaterThan(0);
  });
});

// ── recover (needs gzrecover) ─────────────────────────────────────────────────

describe.skipIf(! hasGzrecover())('recover', () => {
  it('writes a plain .csv (not .csv.gz) preserving the recoverable prefix', async () => {
    const original = HEADER + Array.from(
      { length: 200 },
      (_, i) => row(`2026-04-11T00:00:${String(i % 60).padStart(2, '0')}.000Z`),
    ).join('');
    const src  = path.join(dir, 'to-recover.csv.gz');
    const good = zlib.gzipSync(original);

    fs.writeFileSync(src, good.subarray(0, good.length - 8));   // corrupt it

    const outPath = await _test_recoverFile(src).then(o => o.outPath);

    expect(outPath.endsWith('.recovered.csv')).toBe(true);
    expect(outPath.endsWith('.csv.gz')).toBe(false);
    expect(fs.existsSync(outPath)).toBe(true);
    expect(fs.readFileSync(outPath, 'utf8').startsWith(HEADER)).toBe(true);
  });
});
