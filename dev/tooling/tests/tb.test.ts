import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

// The ./tb wrapper runs from a copy in a scratch root, with a stand-in dx.js and a fake docker on
// PATH that records its calls. `docker network inspect` fails until the network has been created.

const TB = path.resolve(__dirname, '../../../tb');

let root: string;
let bin: string;
let calls: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tooling-tb-'));
  bin = path.join(root, 'bin');
  calls = path.join(root, 'docker-calls');

  fs.copyFileSync(TB, path.join(root, 'tb'));
  fs.chmodSync(path.join(root, 'tb'), 0o755);

  fs.mkdirSync(path.join(root, 'dx'));
  fs.writeFileSync(
    path.join(root, 'dx', 'dx.js'),
    "console.log(JSON.stringify({ executor: process.env.DX_EXECUTOR, args: process.argv.slice(2) }));\n"
  );

  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(bin, 'docker'),
    [
      '#!/bin/bash',
      `echo "$*" >> "${calls}"`,
      `if [ "$1 $2" = "network inspect" ]; then [ -f "${root}/created-$3" ]; exit; fi`,
      `if [ "$1 $2" = "network create" ]; then touch "${root}/created-$3" 2>/dev/null; echo "network-id"; fi`,
      '',
    ].join('\n')
  );
  fs.chmodSync(path.join(bin, 'docker'), 0o755);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function runTb(env: Record<string, string> = {}, args: string[] = []): string {
  const base = { ...process.env };
  delete base.PROJECT_NAME;
  return execFileSync(path.join(root, 'tb'), args, {
    env: { ...base, PATH: `${bin}${path.delimiter}${process.env.PATH}`, ...env },
    encoding: 'utf8',
  });
}

function dockerCalls(): string[] {
  return fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n') : [];
}

function writeEnv(content: string): void {
  fs.writeFileSync(path.join(root, '.env'), content);
}

describe('./tb', () => {
  it('creates tradebot-network when no PROJECT_NAME is set anywhere', () => {
    runTb();
    expect(dockerCalls()).toEqual(['network inspect tradebot-network', 'network create tradebot-network']);
  });

  it('leaves an existing network alone', () => {
    fs.writeFileSync(path.join(root, 'created-tradebot-network'), '');
    runTb();
    expect(dockerCalls()).toEqual(['network inspect tradebot-network']);
  });

  it('runs dx with the arguments and the executor name, keeping docker output off stdout', () => {
    const out = runTb({}, ['up', 'local']);
    expect(JSON.parse(out)).toEqual({ executor: 'tb', args: ['up', 'local'] });
  });

  it('takes PROJECT_NAME from the environment over the root .env', () => {
    writeEnv('PROJECT_NAME=fromfile\n');
    runTb({ PROJECT_NAME: 'fromenv' });
    expect(dockerCalls()[0]).toBe('network inspect fromenv-network');
  });

  it.each([
    ['a plain value', 'PROJECT_NAME=desk\n'],
    ['a double-quoted value', 'PROJECT_NAME="desk"\n'],
    ['a single-quoted value', "PROJECT_NAME='desk'\n"],
    ['a trailing comment', 'PROJECT_NAME=desk   # the shared network prefix\n'],
    ['CRLF line endings', 'PROJECT_NAME=desk\r\n'],
    ['no final newline', 'OTHER=1\nPROJECT_NAME=desk'],
  ])('reads PROJECT_NAME from the root .env with %s', (_label, content) => {
    writeEnv(content);
    runTb();
    expect(dockerCalls()[0]).toBe('network inspect desk-network');
  });

  it.each([
    ['an empty value', 'PROJECT_NAME=\n'],
    ['a comment-only value', 'PROJECT_NAME=  # set me\n'],
    ['a value that starts with #', 'PROJECT_NAME=#set me\n'],
    ['a commented-out line', '# PROJECT_NAME=desk\n'],
    ['only other keys', 'MY_PROJECT_NAME=desk\nPROJECT_NAMES=desk\n'],
  ])('falls back to tradebot for %s', (_label, content) => {
    writeEnv(content);
    runTb();
    expect(dockerCalls()[0]).toBe('network inspect tradebot-network');
  });

  it('reads the root .env without running it', () => {
    writeEnv(`touch "${root}/ran"\nPROJECT_NAME=$(touch "${root}/ran")\n`);
    runTb();
    expect(fs.existsSync(path.join(root, 'ran'))).toBe(false);
    expect(dockerCalls()[0]).toBe(`network inspect $(touch "${root}/ran")-network`);
  });
});
