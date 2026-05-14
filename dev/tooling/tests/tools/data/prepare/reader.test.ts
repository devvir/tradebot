import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import {
  read,
  _test_ISO_DATE_RE,
} from '../../../../src/tools/data/prepare/tasks/reader';
import { _test_isoToMs } from '../../../../src/tools/data/prepare/tasks/ts-resolver';
import { _test_setColumns, _test_clearColumns } from '../../../../src/tools/data/tables';
import type { ReadIssue } from '../../../../src/tools/data/prepare/types';

// ── Test fixture ─────────────────────────────────────────────────────────────

const COLUMNS = ['_date_', '_action_', 'timestamp', 'symbol', 'price'];

// 'orderBookL2' → fixedPartials=false (timestamped, real-state table)
// 'announcement' → fixedPartials=true
const TABLE        = 'orderBookL2';
const FIXED_TABLE  = 'announcement';

beforeAll(() => {
  _test_setColumns(TABLE,       COLUMNS);
  _test_setColumns(FIXED_TABLE, COLUMNS);
});

afterAll(() => {
  _test_clearColumns(TABLE);
  _test_clearColumns(FIXED_TABLE);
});

function writeGz(content: string): string {
  const dir  = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-test-'));
  const file = path.join(dir, 'in.csv.gz');

  fs.writeFileSync(file, zlib.gzipSync(content));

  return file;
}

async function readAll(
  file:      string,
  tableName: string = TABLE,
): Promise<{ messages: ReturnType<typeof flat>; issues: ReadIssue[] }> {
  const issues: ReadIssue[] = [];
  const out: any[] = [];

  for await (const batch of read(tableName, file, i => issues.push(i))) {
    out.push(...batch);
  }

  return { messages: flat(out), issues };
}

function flat(msgs: any[]): { date: string; action: string; ts: string }[] {
  return msgs.map(m => ({ date: m.date, action: m.action, ts: m.ts }));
}

// ── ISO regex ────────────────────────────────────────────────────────────────

describe('ISO_DATE_RE', () => {
  it('accepts standard 3-decimal ISO', () => {
    expect(_test_ISO_DATE_RE.test('2026-01-01T12:00:00.000Z')).toBe(true);
  });

  it('accepts no-decimal ISO', () => {
    expect(_test_ISO_DATE_RE.test('2026-01-01T12:00:00Z')).toBe(true);
  });

  it('accepts legacy 8-and-9-decimal precision', () => {
    expect(_test_ISO_DATE_RE.test('2022-01-01T00:00:00.12345678Z')).toBe(true);
    expect(_test_ISO_DATE_RE.test('2022-01-01T00:00:00.123456789Z')).toBe(true);
  });

  it('rejects timezone offsets', () => {
    expect(_test_ISO_DATE_RE.test('2026-01-01T12:00:00.000+00:00')).toBe(false);
  });

  it('rejects malformed', () => {
    expect(_test_ISO_DATE_RE.test('not a date')).toBe(false);
    expect(_test_ISO_DATE_RE.test('2026-01-01')).toBe(false);
  });
});

// ── isoToMs ─────────────────────────────────────────────────────────────────

describe('isoToMs', () => {
  it('matches Date.parse on canonical ISO', () => {
    expect(_test_isoToMs('2026-01-01T00:00:00.000')).toBe(Date.parse('2026-01-01T00:00:00.000Z'));
    expect(_test_isoToMs('2026-06-15T12:34:56.789')).toBe(Date.parse('2026-06-15T12:34:56.789Z'));
  });
});

// ── End-to-end read ─────────────────────────────────────────────────────────

describe('read — happy path', () => {
  it('parses a well-formed file', async () => {
    const file = writeGz([
      COLUMNS.join(','),
      '2026-01-01T12:00:00.000Z,update,2026-01-01T12:00:00.000Z,XBT,100',
      '2026-01-01T12:00:01.000Z,update,2026-01-01T12:00:01.000Z,XBT,101',
    ].join('\n') + '\n');

    const { messages, issues } = await readAll(file);

    expect(issues).toEqual([]);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({
      date:   '2026-01-01T12:00:00.000Z',
      action: 'update',
      ts:     '2026-01-01T12:00:00.000',
    });
  });

  it('drops the header row', async () => {
    const file = writeGz([
      COLUMNS.join(','),
      '2026-01-01T12:00:00.000Z,update,2026-01-01T12:00:00.000Z,XBT,100',
    ].join('\n') + '\n');

    const { messages } = await readAll(file);

    expect(messages).toHaveLength(1);
  });

  it('falls back to _date_ when timestamp is empty', async () => {
    const file = writeGz([
      COLUMNS.join(','),
      '2026-01-01T12:00:00.000Z,update,,XBT,100',
    ].join('\n') + '\n');

    const { messages } = await readAll(file);

    expect(messages[0]?.ts).toBe('2026-01-01T12:00:00.000');
  });

  it('groups continuation rows into one message', async () => {
    const file = writeGz([
      COLUMNS.join(','),
      '2026-01-01T12:00:00.000Z,insert,,XBT,100',
      ',,,XBT,101',
      ',,,XBT,102',
    ].join('\n') + '\n');

    const { messages } = await readAll(file);

    expect(messages).toHaveLength(1);
  });
});

describe('read — sanity checks', () => {
  it('drops a message with invalid _date_', async () => {
    const file = writeGz([
      COLUMNS.join(','),
      'bad-date,update,2026-01-01T12:00:00.000Z,XBT,100',
      '2026-01-01T12:00:01.000Z,update,2026-01-01T12:00:01.000Z,XBT,101',
    ].join('\n') + '\n');

    const { messages, issues } = await readAll(file);

    expect(messages).toHaveLength(1);
    expect(messages[0]?.date).toBe('2026-01-01T12:00:01.000Z');
    expect(issues).toHaveLength(1);
    expect(issues[0]?.reason).toContain('invalid _date_');
  });

  it('drops a message with invalid _action_', async () => {
    const file = writeGz([
      COLUMNS.join(','),
      '2026-01-01T12:00:00.000Z,bogus,2026-01-01T12:00:00.000Z,XBT,100',
    ].join('\n') + '\n');

    const { messages, issues } = await readAll(file);

    expect(messages).toEqual([]);
    expect(issues[0]?.reason).toContain('invalid _action_');
  });

  it('drops a message with invalid timestamp on continuation row', async () => {
    const file = writeGz([
      COLUMNS.join(','),
      '2026-01-01T12:00:00.000Z,insert,2026-01-01T12:00:00.000Z,XBT,100',
      ',,bad-ts,XBT,101',
    ].join('\n') + '\n');

    const { messages, issues } = await readAll(file);

    expect(messages).toEqual([]);
    expect(issues[0]?.reason).toContain('invalid timestamp');
  });

  it('drops a message whose row has wrong field count', async () => {
    const file = writeGz([
      COLUMNS.join(','),
      '2026-01-01T12:00:00.000Z,update,2026-01-01T12:00:00.000Z,XBT', // missing price
      '2026-01-01T12:00:01.000Z,update,2026-01-01T12:00:01.000Z,XBT,101',
    ].join('\n') + '\n');

    const { messages, issues } = await readAll(file, FIXED_TABLE);

    expect(messages).toHaveLength(1);
    expect(messages[0]?.date).toBe('2026-01-01T12:00:01.000Z');
    expect(issues[0]?.reason).toContain('field count');
  });
});

describe('read — partials', () => {
  it('drops partials when fixedPartials is true', async () => {
    const file = writeGz([
      COLUMNS.join(','),
      '2026-01-01T12:00:00.000Z,partial,,XBT,',
      '2026-01-01T12:00:01.000Z,update,2026-01-01T12:00:01.000Z,XBT,100',
    ].join('\n') + '\n');

    const { messages } = await readAll(file, FIXED_TABLE);

    expect(messages).toHaveLength(1);
    expect(messages[0]?.action).toBe('update');
  });

  it('keeps partials when fixedPartials is false', async () => {
    const file = writeGz([
      COLUMNS.join(','),
      '2026-01-01T12:00:00.000Z,partial,2026-01-01T12:00:00.000Z,XBT,100',
    ].join('\n') + '\n');

    const { messages } = await readAll(file, TABLE);

    expect(messages).toHaveLength(1);
    expect(messages[0]?.action).toBe('partial');
  });
});

describe('read — filtered partials (partial:<symbol>)', () => {
  it('accepts partial:<symbol> as a valid action', async () => {
    const file = writeGz([
      COLUMNS.join(','),
      '2026-01-01T12:00:00.000Z,partial:XBTUSD,2026-01-01T12:00:00.000Z,XBTUSD,100',
      '2026-01-01T12:00:01.000Z,update,2026-01-01T12:00:01.000Z,XBTUSD,101',
    ].join('\n') + '\n');

    const { messages, issues } = await readAll(file);

    expect(issues).toEqual([]);
    expect(messages).toHaveLength(2);
    expect(messages[0]?.action).toBe('partial:XBTUSD');
  });

  it('preserves the full partial:<symbol> action string in output', async () => {
    const file = writeGz([
      COLUMNS.join(','),
      '2026-01-01T12:00:00.000Z,partial:XBT7D_U105,2026-01-01T12:00:00.000Z,XBT7D_U105,50',
    ].join('\n') + '\n');

    const { messages } = await readAll(file);

    expect(messages[0]?.action).toBe('partial:XBT7D_U105');
  });

  it('drops partial:<symbol> when fixedPartials is true', async () => {
    const file = writeGz([
      COLUMNS.join(','),
      '2026-01-01T12:00:00.000Z,partial:XBTUSD,,XBTUSD,',
      '2026-01-01T12:00:01.000Z,update,2026-01-01T12:00:01.000Z,XBTUSD,100',
    ].join('\n') + '\n');

    const { messages } = await readAll(file, FIXED_TABLE);

    expect(messages).toHaveLength(1);
    expect(messages[0]?.action).toBe('update');
  });

  it('does not report partial:<symbol> as a validation issue', async () => {
    const file = writeGz([
      COLUMNS.join(','),
      '2026-01-01T12:00:00.000Z,partial:ETHUSD,2026-01-01T12:00:00.000Z,ETHUSD,200',
    ].join('\n') + '\n');

    const { issues } = await readAll(file);

    expect(issues).toEqual([]);
  });
});
