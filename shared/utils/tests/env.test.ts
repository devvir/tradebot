import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseEnv, parseEnvFile } from '../src/env';
import { loadTestingEnv } from '../src/testing/env';

let dir: string;

const envFile = (content: string): string => {
  const path = join(dir, '.env');
  writeFileSync(path, content);
  return path;
};

const values = (content: string): Record<string, string> => parseEnv(content).values;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'utils-env-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('parseEnv', () => {
  it('reads KEY=VALUE lines and skips blanks, comments and lines of any other form', () => {
    expect(values('# a comment\n\nA=1\n  # indented comment\nnot an assignment\n1BAD=x\nB = two\n'))
      .toEqual({ A: '1', B: 'two' });
  });

  it('keeps every = after the first in the value', () => {
    expect(values('URL=http://host/path?a=1&b=2\n')).toEqual({ URL: 'http://host/path?a=1&b=2' });
  });

  it('removes an export prefix', () => {
    expect(values('export A=1\n')).toEqual({ A: '1' });
  });

  it('accepts dots and dashes in a key', () => {
    expect(values('a.b-c=1\n')).toEqual({ 'a.b-c': '1' });
  });

  it('trims whitespace around keys and unquoted values', () => {
    expect(values('  KEY  =  value  \n')).toEqual({ KEY: 'value' });
  });

  it('gives a key set twice its last value', () => {
    expect(values('A=1\nA=2\n')).toEqual({ A: '2' });
  });

  it('reads CRLF line endings', () => {
    expect(values('A=1\r\nB="two"\r\n')).toEqual({ A: '1', B: 'two' });
  });

  it('ends an unquoted value at a space followed by #', () => {
    expect(values('DIR=/data   # where\nTWO=a # b # c\nCOLOUR=#ff0000\nURL=http://host/#anchor\n'))
      .toEqual({ DIR: '/data', TWO: 'a', COLOUR: '#ff0000', URL: 'http://host/#anchor' });
  });

  it('takes a # with nothing before it as the value', () => {
    expect(values('EMPTY=   # nothing set\nTIGHT=#note\n')).toEqual({ EMPTY: '# nothing set', TIGHT: '#note' });
  });

  it('keeps a # after a tab in an unquoted value', () => {
    expect(values('TAB=x\t# not a comment\n')).toEqual({ TAB: 'x\t# not a comment' });
  });

  it('strips the quotes around a value and keeps a # inside them', () => {
    expect(values('A="a # b"\nB=\'c #d\'\n')).toEqual({ A: 'a # b', B: 'c #d' });
  });

  it('leaves a comment after the closing quote out of the value, with or without a space before it', () => {
    expect(values('A="v" # note\nB=\'w\'   # other\nC="x"#tight\nD=""  # empty\n'))
      .toEqual({ A: 'v', B: 'w', C: 'x', D: '' });
  });

  it('unescapes \\n, \\" and \\\\ in double quotes only, keeping other backslashes', () => {
    expect(values('D="line\\none \\"q\\" back\\\\slash \\t"\nS=\'raw\\n\'\n'))
      .toEqual({ D: 'line\none "q" back\\slash \\t', S: 'raw\\n' });
  });

  it('reads a quote that does not close the value, or is followed by more than a comment, as unquoted', () => {
    expect(values('A="\nB="open\nC="x"y\nD=\'p\'q\n')).toEqual({ A: '"', B: '"open', C: '"x"y', D: "'p'q" });
  });

  it('marks the single-quoted keys as literal, by their last assignment', () => {
    expect([...parseEnv("A='1'\nB=\"2\"\nC=3\nD='4'\nD=5\n").literal]).toEqual(['A']);
  });

  it('leaves ${VAR} references as written', () => {
    expect(values('A=1\nB=${A}\n')).toEqual({ A: '1', B: '${A}' });
  });
});

describe('parseEnvFile', () => {
  it('expands ${VAR} in unquoted and double-quoted values from an earlier key', () => {
    expect(parseEnvFile(envFile('A=one\nB=${A}-x\nC="${A}"\n'), {})).toEqual({ A: 'one', B: 'one-x', C: 'one' });
  });

  it('takes a reference from the lookup before an earlier key', () => {
    expect(parseEnvFile(envFile('A=file\nB=${A}\n'), { A: 'shell' })).toEqual({ A: 'file', B: 'shell' });
  });

  it('takes an empty lookup value as set', () => {
    expect(parseEnvFile(envFile('A=file\nB=[${A}]\n'), { A: '' })).toEqual({ A: 'file', B: '[]' });
  });

  it('expands a reference to an unset variable, or a later key, to the empty string', () => {
    expect(parseEnvFile(envFile('B=[${UNSET}][${C}]\nC=later\n'), {})).toEqual({ B: '[][]', C: 'later' });
  });

  it('does not expand a single-quoted value', () => {
    expect(parseEnvFile(envFile("A=one\nB='${A}'\n"), {})).toEqual({ A: 'one', B: '${A}' });
  });

  it('expands only the ${VAR} form', () => {
    expect(parseEnvFile(envFile('A=one\nB=$A ${A:-d}\n'), {})).toEqual({ A: 'one', B: '$A ${A:-d}' });
  });

  it('looks references up in process.env by default', () => {
    process.env.UTILS_ENV_TEST_OUTER = 'outer';
    try {
      expect(parseEnvFile(envFile('B=${UTILS_ENV_TEST_OUTER}\n'))).toEqual({ B: 'outer' });
    } finally {
      delete process.env.UTILS_ENV_TEST_OUTER;
    }
  });

  it('throws for a file that does not exist', () => {
    expect(() => parseEnvFile(join(dir, 'missing.env'))).toThrow(/ENOENT/);
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
    writeFileSync(join(dir, '.env.testing'), 'UTILS_ENV_TEST_A=file\nUTILS_ENV_TEST_B=file\nUTILS_ENV_TEST_C=file # note\n');

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
