import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseEnvFile, loadEnv, getShellEnv } from '../../../src/shared/utils/env';

function writeTmp(name: string, content: string): string {
  const file = path.join(os.tmpdir(), name);
  fs.writeFileSync(file, content, 'utf-8');
  return file;
}

describe('parseEnvFile', () => {
  it('returns empty object for non-existent file', () => {
    expect(parseEnvFile('/nonexistent/.env.does-not-exist')).toEqual({});
  });

  it('parses key=value pairs', () => {
    const file = writeTmp('env-test-basic.env', 'FOO=bar\nBAZ=qux\n');
    expect(parseEnvFile(file)).toEqual({ FOO: 'bar', BAZ: 'qux' });
    fs.unlinkSync(file);
  });

  it('skips comment lines and blank lines', () => {
    const file = writeTmp('env-test-comments.env', '# comment\n\nFOO=bar\n# another\n');
    expect(parseEnvFile(file)).toEqual({ FOO: 'bar' });
    fs.unlinkSync(file);
  });

  it('handles = characters inside values', () => {
    const file = writeTmp('env-test-equals.env', 'URL=http://host/path?a=1&b=2\n');
    expect(parseEnvFile(file)).toEqual({ URL: 'http://host/path?a=1&b=2' });
    fs.unlinkSync(file);
  });

  /** As docker compose reads the same files: a # after whitespace starts a comment. */
  it('leaves an inline comment out of the value', () => {
    const file = writeTmp('env-test-inline.env',
      'DIR=/data/vault        # Default: somewhere\nEMPTY=   # nothing set\nCOLOUR=#ff0000\nURL=http://host/#anchor\n');
    expect(parseEnvFile(file)).toEqual({ DIR: '/data/vault', EMPTY: '', COLOUR: '#ff0000', URL: 'http://host/#anchor' });
    fs.unlinkSync(file);
  });

  it('trims whitespace from keys and values', () => {
    const file = writeTmp('env-test-trim.env', '  KEY  =  value  \n');
    expect(parseEnvFile(file)).toEqual({ KEY: 'value' });
    fs.unlinkSync(file);
  });

  it('ignores lines without an = separator', () => {
    const file = writeTmp('env-test-noeq.env', 'NOEQUALS\nFOO=bar\n');
    expect(parseEnvFile(file)).toEqual({ FOO: 'bar' });
    fs.unlinkSync(file);
  });
});

describe('loadEnv precedence', () => {
  const UNIQUE = 'TOOLING_TEST_VAR_99999';

  afterEach(() => {
    delete process.env[UNIQUE];
  });

  it('applies additional file vars when not already in process.env', () => {
    const file = writeTmp('env-load-additional.env', `${UNIQUE}=from_file\n`);
    delete process.env[UNIQUE];

    loadEnv(file);

    expect(process.env[UNIQUE]).toBe('from_file');
    fs.unlinkSync(file);
  });

  it('process.env overrides the additional file', () => {
    const file = writeTmp('env-load-override.env', `${UNIQUE}=from_file\n`);
    process.env[UNIQUE] = 'from_process';

    loadEnv(file);

    expect(process.env[UNIQUE]).toBe('from_process');
    fs.unlinkSync(file);
  });
});

describe('getShellEnv', () => {
  const FROM_FILE = 'TOOLING_TEST_FILE_VAR_99999';
  const FROM_SHELL = 'TOOLING_TEST_SHELL_VAR_99999';

  afterEach(() => {
    delete process.env[FROM_FILE];
    delete process.env[FROM_SHELL];
  });

  it('returns what the shell exported, not what loadEnv merged in from a file', () => {
    const file = writeTmp('env-shell.env', `${FROM_FILE}=from_file\n${FROM_SHELL}=from_file\n`);
    process.env[FROM_SHELL] = 'from_shell';

    loadEnv(file);

    expect(process.env[FROM_FILE]).toBe('from_file');
    expect(getShellEnv(FROM_FILE)).toBeUndefined();
    expect(getShellEnv(FROM_SHELL)).toBe('from_shell');
    fs.unlinkSync(file);
  });

  it('does not take a value an earlier loadEnv wrote for one the shell exported', () => {
    const file = writeTmp('env-shell-twice.env', `${FROM_FILE}=from_file\n`);

    loadEnv(file);
    loadEnv(file);

    expect(getShellEnv(FROM_FILE)).toBeUndefined();
    fs.unlinkSync(file);
  });
});
