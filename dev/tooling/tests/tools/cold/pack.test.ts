import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearTemporary, membersOf, writePart } from '../../../src/tools/cold/tar';

/**
 * A tar is written, then proven, then named — and a run stopped between any two
 * of those picks up at the step it was on, repeating none and skipping none.
 */

let dir:  string;
let root: string;
let tar:  string;

const MEMBERS = ['trades/a.zip', 'trades/b.zip'];

const put = (relative: string, content: string): void => {
  fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
  fs.writeFileSync(path.join(root, relative), content);
};

/** A tar of these members, written as a run stopped before verifying would leave it. */
const leaveUnverified = (members: string[]): void => {
  fs.mkdirSync(path.dirname(tar), { recursive: true });
  execFileSync('tar', ['-cf', `${tar}.unverified`, '-C', root, ...members]);
};

beforeEach(() => {
  dir  = fs.mkdtempSync(path.join(os.tmpdir(), 'cold-pack-'));
  root = path.join(dir, 'archives');
  tar  = path.join(dir, 'staged', 'gate-202006.001.tar');

  put('trades/a.zip', 'a');
  put('trades/b.zip', 'b');
  put('klines/k.zip', 'k');
});

afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('packing a tar', () => {
  it('leaves only the finished tar behind', async () => {
    await writePart(root, tar, MEMBERS);

    expect(fs.readdirSync(path.dirname(tar))).toEqual(['gate-202006.001.tar']);
    expect(await membersOf(tar)).toEqual(MEMBERS);
  });

  it('says when it starts comparing, once the tar is written in full', async () => {
    let seen: string[] = [];

    await writePart(root, tar, MEMBERS, () => { seen = fs.readdirSync(path.dirname(tar)); });

    expect(seen).toContain('gate-202006.001.tar.unverified');
    expect(seen).not.toContain('gate-202006.001.tar');
  });

  /** Written in full by a run that stopped before proving it: proven, not written again. */
  it('verifies a tar an earlier run wrote, without writing it again', async () => {
    leaveUnverified(MEMBERS);

    const written = fs.statSync(`${tar}.unverified`).ino;

    await writePart(root, tar, MEMBERS);

    expect(fs.statSync(tar).ino).toBe(written);
    expect(fs.existsSync(`${tar}.unverified`)).toBe(false);
  });

  /** The plan is redrawn every run, so the tar found may be another plan's. */
  it('writes it again where what was left is not what this plan holds', async () => {
    leaveUnverified(['klines/k.zip']);

    await writePart(root, tar, MEMBERS);

    expect(await membersOf(tar)).toEqual(MEMBERS);
  });

  it('never names a tar that does not match its source, and does not keep it', async () => {
    leaveUnverified(MEMBERS);
    put('trades/a.zip', 'changed since');

    await expect(writePart(root, tar, MEMBERS)).rejects.toThrow();

    expect(fs.readdirSync(path.dirname(tar))).toEqual([]);
  });

  /** A half-written tar is worth nothing; one written in full is kept for the next run. */
  it('clears a tar that was being written at startup, and keeps one written in full', async () => {
    leaveUnverified(MEMBERS);
    fs.writeFileSync(`${tar}.tmp`, 'half');

    expect(await clearTemporary(dir)).toBe(1);
    expect(fs.readdirSync(path.dirname(tar))).toEqual(['gate-202006.001.tar.unverified']);
  });
});
