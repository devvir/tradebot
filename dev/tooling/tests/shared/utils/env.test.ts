import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseEnvFile, loadEnv } from '../../../src/shared/utils/env.js';

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
