import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadTestingEnv, parseEnvFile } from '../src/testing/env';

let dir: string;

const envFile = (content: string): string => {
  const path = join(dir, '.env');
  writeFileSync(path, content);
  return path;
};

const parse = (content: string): Record<string, string> => parseEnvFile(envFile(content));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'utils-env-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('parseEnvFile', () => {
  it('reads KEY=VALUE lines and skips blanks and comments', () => {
    expect(parse('# a comment\n\nA=1\nnot an assignment\nB = two\n')).toEqual({ A: '1', B: 'two' });
  });

  it('removes an export prefix', () => {
    expect(parse('export A=1\n')).toEqual({ A: '1' });
  });

  it('strips the quotes around a value', () => {
    expect(parse('A="a # b"\nB=\'c d\'\n')).toEqual({ A: 'a # b', B: 'c d' });
  });

  it('keeps a quote that does not close the value', () => {
    expect(parse('A="\nB="x\n')).toEqual({ A: '"', B: '"x' });
  });

  it('strips an inline comment from an unquoted value', () => {
    expect(parse('A=value # note\nB=x#y\n')).toEqual({ A: 'value', B: 'x#y' });
  });

  it('strips a comment after a closing quote', () => {
    expect(parse('A="v" # note\n')).toEqual({ A: 'v' });
  });

  it('interpolates from earlier keys, then process.env', () => {
    process.env.UTILS_ENV_TEST_OUTER = 'outer';
    try {
      expect(parse('A=one\nB=${A}-${UTILS_ENV_TEST_OUTER}-${UTILS_ENV_TEST_UNSET}\nC="${A}"\n'))
        .toEqual({ A: 'one', B: 'one-outer-', C: 'one' });
    } finally {
      delete process.env.UTILS_ENV_TEST_OUTER;
    }
  });

  it('does not interpolate a single-quoted value', () => {
    expect(parse("A=one\nB='${A}'\n")).toEqual({ A: 'one', B: '${A}' });
  });
});

describe('loadTestingEnv', () => {
  const KEYS = ['UTILS_ENV_TEST_A', 'UTILS_ENV_TEST_B', 'UTILS_ENV_TEST_C'];

  afterEach(() => {
    for (const key of KEYS) delete process.env[key];
  });

  it('loads .env.testing from the directory, keeping variables that are set, empty included', () => {
    process.env.UTILS_ENV_TEST_A = 'shell';
    process.env.UTILS_ENV_TEST_B = '';
    writeFileSync(join(dir, '.env.testing'), 'UTILS_ENV_TEST_A=file\nUTILS_ENV_TEST_B=file\nUTILS_ENV_TEST_C=file\n');

    loadTestingEnv(dir);

    expect(process.env.UTILS_ENV_TEST_A).toBe('shell');
    expect(process.env.UTILS_ENV_TEST_B).toBe('');
    expect(process.env.UTILS_ENV_TEST_C).toBe('file');
  });

  it('loads nothing from a directory without .env.testing', () => {
    expect(() => loadTestingEnv(dir)).not.toThrow();
  });

  it('throws when .env.testing cannot be read', () => {
    mkdirSync(join(dir, '.env.testing'));

    expect(() => loadTestingEnv(dir)).toThrow();
  });
});
