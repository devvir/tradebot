import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  _test_fixedOutputPath,
  _test_taskLogPath,
} from '../../../../src/tools/sources/fix/run';
import { openLog } from '../../../../src/tools/sources/fix/log';
import {
  createIssueSummary,
  addToSummary,
  mergeSummaries,
} from '../../../../src/tools/sources/checks/types';
import type { DiagnosticIssue } from '../../../../src/tools/sources/checks/types';

// ── addToSummary / createIssueSummary ─────────────────────────────────────────

function issue(type: DiagnosticIssue['type'], date: string): DiagnosticIssue {
  return { type, message: `test-${type}`, date };
}

describe('createIssueSummary — empty state', () => {
  it('starts with no counts and no samples', () => {
    const s = createIssueSummary();

    expect(Object.keys(s.counts)).toHaveLength(0);
    expect(Object.keys(s.samples)).toHaveLength(0);
  });
});

describe('addToSummary — counting', () => {
  it('increments count per type', () => {
    const s = createIssueSummary();

    addToSummary(s, issue('duplicate',   '2026-01-01T00:00:01.000Z'));
    addToSummary(s, issue('wrong-order', '2026-01-01T00:00:02.000Z'));
    addToSummary(s, issue('duplicate',   '2026-01-01T00:00:03.000Z'));

    expect(s.counts['duplicate']).toBe(2);
    expect(s.counts['wrong-order']).toBe(1);
  });
});

describe('addToSummary — sample limit', () => {
  it('keeps only the first SAMPLE_LIMIT samples per type', () => {
    const s = createIssueSummary();

    for (let i = 0; i < 20; i++) {
      addToSummary(s, issue('gap', `2026-01-01T00:${String(i).padStart(2, '0')}:00.000Z`));
    }

    expect(s.samples['gap']).toHaveLength(5);
    expect(s.counts['gap']).toBe(20);
  });

  it('keeps the first samples, not the last', () => {
    const s = createIssueSummary();

    addToSummary(s, issue('gap', '2026-01-01T00:00:01.000Z'));
    addToSummary(s, issue('gap', '2026-01-01T00:00:02.000Z'));
    addToSummary(s, issue('gap', '2026-01-01T00:00:03.000Z'));

    const samples = s.samples['gap'] ?? [];

    expect(samples[0]?.date).toBe('2026-01-01T00:00:01.000Z');
    expect(samples[1]?.date).toBe('2026-01-01T00:00:02.000Z');
  });

  it('keeps all when below the limit', () => {
    const s = createIssueSummary();

    addToSummary(s, issue('duplicate', '2026-01-01T00:00:01.000Z'));
    addToSummary(s, issue('duplicate', '2026-01-01T00:00:02.000Z'));

    expect(s.samples['duplicate']).toHaveLength(2);
  });
});

describe('mergeSummaries', () => {
  it('sums counts from both summaries', () => {
    const a = createIssueSummary();
    const b = createIssueSummary();

    addToSummary(a, issue('duplicate', '2026-01-01T00:00:01.000Z'));
    addToSummary(b, issue('duplicate', '2026-01-01T00:00:02.000Z'));
    addToSummary(b, issue('gap',       '2026-01-01T00:00:03.000Z'));

    const m = mergeSummaries(a, b);

    expect(m.counts['duplicate']).toBe(2);
    expect(m.counts['gap']).toBe(1);
  });

  it('caps merged samples at SAMPLE_LIMIT', () => {
    const a = createIssueSummary();
    const b = createIssueSummary();

    for (let i = 0; i < 4; i++) addToSummary(a, issue('gap', `2026-01-01T00:0${i}:00.000Z`));
    for (let i = 0; i < 4; i++) addToSummary(b, issue('gap', `2026-01-01T01:0${i}:00.000Z`));

    const m = mergeSummaries(a, b);

    expect((m.samples['gap'] ?? []).length).toBeLessThanOrEqual(5);
    expect(m.counts['gap']).toBe(8);
  });
});

// ── fixedOutputPath ───────────────────────────────────────────────────────────

describe('fixedOutputPath', () => {
  it('replaces .csv.gz with .fixed.csv.gz', () => {
    expect(_test_fixedOutputPath('/vault/trade/2026/20260101.csv.gz'))
      .toBe('/vault/trade/2026/20260101.fixed.csv.gz');
  });

  it('replaces plain .csv with .fixed.csv.gz', () => {
    expect(_test_fixedOutputPath('/vault/trade/2026/20260101.csv'))
      .toBe('/vault/trade/2026/20260101.fixed.csv.gz');
  });
});

// ── taskLogPath ───────────────────────────────────────────────────────────────

describe('taskLogPath', () => {
  it('derives a .log file under logDir from the source basename', () => {
    expect(_test_taskLogPath('/tmp/logs', '/vault/trade/2026/20260326.csv.gz'))
      .toBe('/tmp/logs/20260326.log');
  });

  it('handles plain .csv source files', () => {
    expect(_test_taskLogPath('/tmp/logs', '/vault/trade/2026/20260326.csv'))
      .toBe('/tmp/logs/20260326.log');
  });

  it('honours relative log directories', () => {
    expect(_test_taskLogPath('.', '/vault/trade/2026/20260326.csv.gz'))
      .toBe('20260326.log');
  });
});

// ── openLog ───────────────────────────────────────────────────────────────────

/** Wait briefly for the write stream to flush. */
function waitForFlush(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 50));
}

describe('openLog', () => {
  function tmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'sources-log-'));
  }

  it('writes header info and "no issues" summary', async () => {
    const dir     = tmpDir();
    const logFile = path.join(dir, 'file.log');

    const log = openLog(logFile, '/vault/trade/a.csv.gz', 'trade');

    log.summary(1000, 1000, createIssueSummary(), false);
    log.close();
    await waitForFlush();

    const text = fs.readFileSync(logFile, 'utf8');

    expect(text).toContain('File:    /vault/trade/a.csv.gz');
    expect(text).toContain('Table:   trade');
    expect(text).toContain('Scanned: 1,000 messages');
    expect(text).toContain('No issues found.');
    expect(text).toContain('Written: 1,000 messages');
  });

  it('logs issues in real-time and summarises counts', async () => {
    const dir     = tmpDir();
    const logFile = path.join(dir, 'file.log');

    const log     = openLog(logFile, '/vault/trade/a.csv.gz', 'trade');
    const summary = createIssueSummary();

    const issues: DiagnosticIssue[] = [
      { type: 'duplicate',   message: 'dup', date: '2026-01-01T00:00:01.000Z' },
      { type: 'wrong-order', message: 'wo',  date: '2026-01-01T00:00:03.000Z' },
    ];

    for (const i of issues) {
      log.issue(i);
      addToSummary(summary, i);
    }

    log.summary(100, 98, summary, false);
    log.close();
    await waitForFlush();

    const text = fs.readFileSync(logFile, 'utf8');

    expect(text).toContain('[duplicate]');
    expect(text).toContain('[wrong-order]');
    expect(text).toContain('duplicate: 1  (fixed)');
    expect(text).toContain('wrong-order: 1  (fixed)');
  });

  it('uses "Would write" for dry-run summaries', async () => {
    const dir     = tmpDir();
    const logFile = path.join(dir, 'file.log');

    const log = openLog(logFile, '/vault/trade/a.csv.gz', 'trade');

    log.summary(50, 50, createIssueSummary(), true);
    log.close();
    await waitForFlush();

    const text = fs.readFileSync(logFile, 'utf8');

    expect(text).toContain('Would write: 50 messages');
    expect(text).not.toContain('Written: 50 messages');
  });

  it('creates the log directory if it does not exist', async () => {
    const dir     = tmpDir();
    const logFile = path.join(dir, 'nested', 'sub', 'file.log');

    const log = openLog(logFile, '/vault/a.csv.gz', 'trade');

    log.summary(1, 1, createIssueSummary(), false);
    log.close();
    await waitForFlush();

    expect(fs.existsSync(logFile)).toBe(true);
  });
});
