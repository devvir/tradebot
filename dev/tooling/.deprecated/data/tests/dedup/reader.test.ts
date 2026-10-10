import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { read } from '../../../../src/tools/data/dedup/reader';
import type { Message } from '../../../../src/tools/data/types';

// ── Helpers ──────────────────────────────────────────────────────────────────

const tmpDirs: string[] = [];

function writeGz(content: string): string {
  const dir  = fs.mkdtempSync(path.join(os.tmpdir(), 'dedup-reader-test-'));
  const file = path.join(dir, 'test.csv.gz');

  tmpDirs.push(dir);
  fs.writeFileSync(file, zlib.gzipSync(content));

  return file;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

async function readAll(file: string): Promise<Message[]> {
  const out: Message[] = [];

  for await (const batch of read(file)) {
    out.push(...batch);
  }

  return out;
}

// ── Header skipping ──────────────────────────────────────────────────────────

describe('header', () => {
  it('drops the first line when it is a header (starts with _date_)', async () => {
    const file = writeGz(
      '_date_,_action_,symbol\n' +
      '2026-01-01T00:00:01.000Z,insert,X\n',
    );

    const out = await readAll(file);

    expect(out).toHaveLength(1);
    expect(out[0]!.date).toBe('2026-01-01T00:00:01.000Z');
  });

  it('keeps the first line when it is not a header (opens straight on data)', async () => {
    const file = writeGz(
      '2026-01-01T00:00:01.000Z,insert,X\n' +
      '2026-01-01T00:00:02.000Z,insert,Y\n',
    );

    const out = await readAll(file);

    expect(out).toHaveLength(2);
    expect(out[0]!.date).toBe('2026-01-01T00:00:01.000Z');
  });

  it('empty file (header only) returns no messages', async () => {
    const file = writeGz('_date_,_action_,symbol\n');

    const out = await readAll(file);

    expect(out).toHaveLength(0);
  });
});

// ── Message grouping ─────────────────────────────────────────────────────────

describe('message grouping', () => {
  it('each non-continuation line starts a new message', async () => {
    const file = writeGz(
      '_date_,_action_,col\n' +
      '2026-01-01T00:00:01.000Z,insert,A\n' +
      '2026-01-01T00:00:02.000Z,insert,B\n' +
      '2026-01-01T00:00:03.000Z,insert,C\n',
    );

    const out = await readAll(file);

    expect(out).toHaveLength(3);
  });

  it('continuation rows (starting with ,) are folded into the preceding message', async () => {
    const file = writeGz(
      '_date_,_action_,col\n' +
      '2026-01-01T00:00:01.000Z,insert,A\n' +
      ',,,B\n' +
      ',,,C\n' +
      '2026-01-01T00:00:02.000Z,insert,D\n',
    );

    const out = await readAll(file);

    expect(out).toHaveLength(2);
    expect(out[0]!.rows).toEqual([
      '2026-01-01T00:00:01.000Z,insert,A',
      ',,,B',
      ',,,C',
    ]);
    expect(out[1]!.rows).toEqual(['2026-01-01T00:00:02.000Z,insert,D']);
  });

  it('orphan continuation line at start (before any start row) is silently dropped', async () => {
    const file = writeGz(
      '_date_,_action_,col\n' +
      ',orphan\n' +
      '2026-01-01T00:00:01.000Z,insert,A\n',
    );

    const out = await readAll(file);

    expect(out).toHaveLength(1);
    expect(out[0]!.rows).toEqual(['2026-01-01T00:00:01.000Z,insert,A']);
  });

  it('empty lines are skipped', async () => {
    const file = writeGz(
      '_date_,_action_,col\n' +
      '\n' +
      '2026-01-01T00:00:01.000Z,insert,A\n' +
      '\n' +
      '2026-01-01T00:00:02.000Z,insert,B\n',
    );

    const out = await readAll(file);

    expect(out).toHaveLength(2);
  });
});

// ── Field extraction ─────────────────────────────────────────────────────────

describe('field extraction', () => {
  it('date is the first comma-delimited field', async () => {
    const file = writeGz(
      '_date_,_action_,col\n' +
      '2026-06-15T12:34:56.789Z,update,val\n',
    );

    const out = await readAll(file);

    expect(out[0]!.date).toBe('2026-06-15T12:34:56.789Z');
  });

  it('action is the second comma-delimited field', async () => {
    const file = writeGz(
      '_date_,_action_,col\n' +
      '2026-01-01T00:00:00.000Z,delete,val\n',
    );

    const out = await readAll(file);

    expect(out[0]!.action).toBe('delete');
  });

  it('timestamp is always null', async () => {
    const file = writeGz(
      '_date_,_action_,col\n' +
      '2026-01-01T00:00:00.000Z,insert,val\n',
    );

    const out = await readAll(file);

    expect(out[0]!.timestamp).toBeNull();
  });

  it('rows contains the raw CSV lines exactly as stored', async () => {
    const file = writeGz(
      '_date_,_action_,col\n' +
      '2026-01-01T00:00:01.000Z,partial,X\n' +
      ',cont1\n' +
      ',cont2\n',
    );

    const out = await readAll(file);

    expect(out[0]!.rows).toEqual([
      '2026-01-01T00:00:01.000Z,partial,X',
      ',cont1',
      ',cont2',
    ]);
  });
});

// ── End-of-file flush ────────────────────────────────────────────────────────

describe('end-of-file flush', () => {
  it('last in-flight message is yielded even without a trailing newline', async () => {
    const content = '_date_,_action_,col\n2026-01-01T00:00:01.000Z,insert,X';
    const file    = writeGz(content);

    const out = await readAll(file);

    expect(out).toHaveLength(1);
    expect(out[0]!.date).toBe('2026-01-01T00:00:01.000Z');
  });
});
