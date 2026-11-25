import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseEnvFile, loadEnv, getShellEnv } from '../../../src/shared/utils/env';

let tmp: string;
let savedEnv: NodeJS.ProcessEnv;

/** A repository root and a tooling dir with no .env files, so the developer's own never load. */
let dirs: { rootDir: string; toolingDir: string };

beforeEach(() => {
  savedEnv = { ...process.env };
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tooling-env-'));
  dirs = { rootDir: path.join(tmp, 'root'), toolingDir: path.join(tmp, 'root', 'dev', 'tooling') };
  fs.mkdirSync(dirs.toolingDir, { recursive: true });
});

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (! (key in savedEnv)) delete process.env[key];
  }

  Object.assign(process.env, savedEnv);
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function write(relative: string, content: string): string {
  const file = path.join(tmp, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf-8');
  return file;
}

function parse(content: string): Record<string, string> {
  return parseEnvFile(write('parse.env', content));
}

describe('parseEnvFile', () => {
  it('returns empty object for non-existent file', () => {
    expect(parseEnvFile(path.join(tmp, 'missing.env'))).toEqual({});
  });

  it('parses key=value pairs', () => {
    expect(parse('FOO=bar\nBAZ=qux\n')).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  it('skips comment lines and blank lines', () => {
    expect(parse('# comment\n\nFOO=bar\n  # another\n')).toEqual({ FOO: 'bar' });
  });

  it('handles = characters inside values', () => {
    expect(parse('URL=http://host/path?a=1&b=2\n')).toEqual({ URL: 'http://host/path?a=1&b=2' });
  });

  /** As docker compose reads the same files: a # after whitespace starts a comment. */
  it('leaves an inline comment out of the value', () => {
    expect(parse('DIR=/data/vault        # Default: somewhere\nEMPTY=   # nothing set\nCOLOUR=#ff0000\nURL=http://host/#anchor\n'))
      .toEqual({ DIR: '/data/vault', EMPTY: '', COLOUR: '#ff0000', URL: 'http://host/#anchor' });
  });

  it('trims whitespace from keys and values', () => {
    expect(parse('  KEY  =  value  \n')).toEqual({ KEY: 'value' });
  });

  it('ignores lines without an = separator', () => {
    expect(parse('NOEQUALS\nFOO=bar\n')).toEqual({ FOO: 'bar' });
  });

  it('reads a line prefixed with export', () => {
    expect(parse('export FOO=bar\n')).toEqual({ FOO: 'bar' });
  });

  it('strips the quotes around a double-quoted value', () => {
    expect(parse('PASS="se cret"\n')).toEqual({ PASS: 'se cret' });
  });

  it('strips the quotes around a single-quoted value', () => {
    expect(parse("P2='abc'\n")).toEqual({ P2: 'abc' });
  });

  it('keeps a # inside quotes', () => {
    expect(parse('Q="a #b"\nS=\'c #d\'\n')).toEqual({ Q: 'a #b', S: 'c #d' });
  });

  it('leaves a comment after the closing quote out of the value', () => {
    expect(parse('Q="a" # comment\nS=\'b\'   # other\n')).toEqual({ Q: 'a', S: 'b' });
  });

  it('unescapes \\n, \\" and \\\\ inside double quotes only', () => {
    expect(parse('D="line\\none \\"q\\" back\\\\slash"\nS=\'raw\\n\'\n'))
      .toEqual({ D: 'line\none "q" back\\slash', S: 'raw\\n' });
  });

  it('reads a quote that does not close the value as written', () => {
    expect(parse('A="open\nB="x"y\n')).toEqual({ A: '"open', B: '"x"y' });
  });

  it('reads files with CRLF line endings', () => {
    expect(parse('FOO=bar\r\nBAZ="qux"\r\n')).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });
});

describe('loadEnv precedence', () => {
  const KEY = 'TOOLING_TEST_VAR_99999';

  beforeEach(() => {
    delete process.env[KEY];
  });

  it('applies additional file vars when not already in process.env', () => {
    const file = write('extra.env', `${KEY}=from_file\n`);

    loadEnv(file, null, dirs);

    expect(process.env[KEY]).toBe('from_file');
  });

  it('process.env overrides the additional file', () => {
    const file = write('extra.env', `${KEY}=from_file\n`);
    process.env[KEY] = 'from_process';

    loadEnv(file, null, dirs);

    expect(process.env[KEY]).toBe('from_process');
  });

  it('layers root < module < tooling < -e', () => {
    write('root/.env', 'A=root\nB=root\nC=root\nD=root\n');
    write('root/modules/collect/archives/.env', 'B=module\nC=module\nD=module\n');
    write('root/dev/tooling/.env', 'C=tooling\nD=tooling\n');
    const extra = write('extra.env', 'D=extra\n');
    for (const k of ['A', 'B', 'C', 'D']) delete process.env[k];

    const env = loadEnv(extra, 'archives', dirs);

    expect([env.A, env.B, env.C, env.D]).toEqual(['root', 'module', 'tooling', 'extra']);
  });

  it('throws for a -e file that does not exist', () => {
    const missing = path.join(tmp, 'nope.env');

    expect(() => loadEnv(missing, null, dirs)).toThrow(`--env file not found: ${missing}`);
  });
});

describe('loadEnv -m', () => {
  const KEY = 'TOOLING_TEST_MODULE_VAR_99999';

  beforeEach(() => {
    delete process.env[KEY];
  });

  it('finds a module by name under its group', () => {
    write('root/modules/collect/archives/.env', `${KEY}=archives\n`);
    fs.mkdirSync(path.join(dirs.rootDir, 'modules/store/warehouse'), { recursive: true });

    expect(loadEnv(null, 'archives', dirs)[KEY]).toBe('archives');
  });

  it('takes a module named as <group>/<name>', () => {
    write('root/modules/collect/archives/.env', `${KEY}=archives\n`);

    expect(loadEnv(null, 'collect/archives', dirs)[KEY]).toBe('archives');
  });

  it('rejects a name with ..', () => {
    write('root/.env', `${KEY}=root\n`);

    expect(() => loadEnv(null, '../root', dirs)).toThrow(/--module \.\.\/root/);
    expect(() => loadEnv(null, 'collect/../..', dirs)).toThrow(/--module/);
  });

  it('throws for a name no module has', () => {
    fs.mkdirSync(path.join(dirs.rootDir, 'modules/collect/archives'), { recursive: true });

    expect(() => loadEnv(null, 'nonexistent', dirs)).toThrow(/no modules\/nonexistent/);
  });

  it('throws for a name more than one group has', () => {
    write('root/modules/collect/shared/.env', `${KEY}=a\n`);
    write('root/modules/store/shared/.env', `${KEY}=b\n`);

    expect(() => loadEnv(null, 'shared', dirs)).toThrow(/ambiguous.*modules\/collect\/shared.*modules\/store\/shared/);
  });

  it('throws for a module without a .env', () => {
    fs.mkdirSync(path.join(dirs.rootDir, 'modules/collect/archives'), { recursive: true });

    expect(() => loadEnv(null, 'archives', dirs)).toThrow('modules/collect/archives/.env not found');
  });
});

describe('loadEnv ${VAR} expansion', () => {
  const keys = ['XA', 'XB', 'XC', 'XD', 'XLIT', 'XSHELL', 'XMISSING', 'XEMPTY'];

  beforeEach(() => {
    for (const k of keys) delete process.env[k];
  });

  it('resolves a chain of references in any order', () => {
    write('root/.env', 'XA=${XB}/a\nXB=${XC}/b\nXC=/c\n');

    const env = loadEnv(null, null, dirs);

    expect([env.XA, env.XB, env.XC]).toEqual(['/c/b/a', '/c/b', '/c']);
  });

  it('looks a reference up across every layer', () => {
    write('root/.env', 'XA=${XB}/a\n');
    write('root/dev/tooling/.env', 'XB=/tooling\n');

    expect(loadEnv(null, null, dirs).XA).toBe('/tooling/a');
  });

  it('expands a reference to an unset variable to an empty string, and warns once', () => {
    const warned = vi.spyOn(console, 'error').mockImplementation(() => {});
    write('root/.env', 'XA=a${XMISSING}b\nXB=${XMISSING}\nXEMPTY=\nXC=${XEMPTY}c\n');

    const env = loadEnv(null, null, dirs);

    expect([env.XA, env.XB, env.XC]).toEqual(['ab', '', 'c']);
    expect(warned).toHaveBeenCalledTimes(1);
    expect(String(warned.mock.calls[0][0])).toContain('${XMISSING}');
  });

  it('leaves a value the shell exported as it is, but substitutes it into file values', () => {
    process.env.XSHELL = 'ab${XC}cd';
    write('root/.env', 'XSHELL=from_file\nXC=/c\nXA=${XSHELL}\n');

    const env = loadEnv(null, null, dirs);

    expect(process.env.XSHELL).toBe('ab${XC}cd');
    expect(env.XA).toBe('ab${XC}cd');
  });

  it('takes a single-quoted value as written', () => {
    write('root/.env', "XLIT='ab${XC}'\nXC=/c\nXA=${XLIT}\n");

    const env = loadEnv(null, null, dirs);

    expect([env.XLIT, env.XA]).toEqual(['ab${XC}', 'ab${XC}']);
  });

  it('leaves a cycle as written instead of hanging', () => {
    write('root/.env', 'XA=${XB}\nXB=${XA}\nXD=${XD}x\n');

    const env = loadEnv(null, null, dirs);

    expect(env.XA).toContain('${X');
    expect(env.XB).toContain('${X');
    expect(env.XD).toBe('${XD}x');
  });

  it('expands again from the file on a second load, not from the first result', () => {
    write('root/.env', 'XA=${XB}/a\nXB=/b\n');

    loadEnv(null, null, dirs);
    write('root/.env', 'XA=${XB}/a\nXB=/b2\n');
    loadEnv(null, null, dirs);

    expect(process.env.XA).toBe('/b2/a');
  });
});

describe('getShellEnv', () => {
  const FROM_FILE = 'TOOLING_TEST_FILE_VAR_99999';
  const FROM_SHELL = 'TOOLING_TEST_SHELL_VAR_99999';

  beforeEach(() => {
    delete process.env[FROM_FILE];
    delete process.env[FROM_SHELL];
  });

  it('returns what the shell exported, not what loadEnv merged in from a file', () => {
    const file = write('shell.env', `${FROM_FILE}=from_file\n${FROM_SHELL}=from_file\n`);
    process.env[FROM_SHELL] = 'from_shell';

    loadEnv(file, null, dirs);

    expect(process.env[FROM_FILE]).toBe('from_file');
    expect(getShellEnv(FROM_FILE)).toBeUndefined();
    expect(getShellEnv(FROM_SHELL)).toBe('from_shell');
  });

  it('does not take a value an earlier loadEnv wrote for one the shell exported', () => {
    const file = write('shell.env', `${FROM_FILE}=from_file\n`);

    loadEnv(file, null, dirs);
    loadEnv(file, null, dirs);

    expect(getShellEnv(FROM_FILE)).toBeUndefined();
  });
});
