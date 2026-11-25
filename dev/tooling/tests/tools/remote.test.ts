import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

vi.mock('../../src/shared/ui/prompts', () => ({
  input: vi.fn(),
  confirm: vi.fn(),
}));

vi.mock('../../src/shared/ui/logger', () => ({
  info: vi.fn(),
  success: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  section: vi.fn(),
}));

import { execFileSync } from 'node:child_process';
import { confirm, input } from '../../src/shared/ui/prompts';
import { error, success } from '../../src/shared/ui/logger';
import { parseRemoteDest } from '../../src/tools/remote/types';
import { _test_findEnvFiles, run as runSyncEnv } from '../../src/tools/remote/sync-env';

// ── Helpers ───────────────────────────────────────────────────────────────────

let root: string;

function touch(rel: string, content = 'A=1\n'): void {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function calls(): Array<[string, string[]]> {
  return vi.mocked(execFileSync).mock.calls.map(([cmd, args]) => [cmd as string, args as string[]]);
}

beforeEach(() => {
  vi.clearAllMocks();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tooling-sync-env-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

// ── Tests: parseRemoteDest ────────────────────────────────────────────────────

describe('parseRemoteDest', () => {
  it('parses user@host:/path', () => {
    expect(parseRemoteDest('user@host:/remote/path')).toEqual({
      userHost: 'user@host',
      path: '/remote/path',
    });
  });

  it('strips trailing slashes', () => {
    expect(parseRemoteDest('user@host:/remote/path/').path).toBe('/remote/path');
    expect(parseRemoteDest('user@host:/remote/path///').path).toBe('/remote/path');
  });

  it('preserves deep path with subdirectories', () => {
    expect(parseRemoteDest('deploy@192.168.1.1:/data/tradebot/vault')).toEqual({
      userHost: 'deploy@192.168.1.1',
      path: '/data/tradebot/vault',
    });
  });

  it('accepts a path with spaces', () => {
    expect(parseRemoteDest('u@h:/a b')).toEqual({ userHost: 'u@h', path: '/a b' });
  });

  it('splits a bracketed IPv6 host after the closing bracket', () => {
    expect(parseRemoteDest('u@[::1]:/p')).toEqual({ userHost: 'u@[::1]', path: '/p' });
  });

  it('rejects an unclosed IPv6 bracket', () => {
    expect(() => parseRemoteDest('u@[::1/p')).toThrow(/IPv6/);
  });

  it('takes a ~/ path as relative to the login home', () => {
    expect(parseRemoteDest('u@h:~/tradebot').path).toBe('tradebot');
  });

  it('rejects ~ alone and ~user paths', () => {
    expect(() => parseRemoteDest('u@h:~')).toThrow(/~\/dir/);
    expect(() => parseRemoteDest('u@h:~/')).toThrow(/~\/dir/);
    expect(() => parseRemoteDest('u@h:~bob/x')).toThrow(/~\/dir/);
  });

  it.each(['u@h:', 'u@h:/', 'u@h://', 'u@h:/.', 'u@h:/./', 'u@h:/..', 'u@h:/tmp/..', 'u@h:/tmp/../'])(
    'refuses %s as the filesystem root',
    (dest) => {
      expect(() => parseRemoteDest(dest)).toThrow(/filesystem root/);
    },
  );

  it.each(['u@h:~/.', 'u@h:~/..', 'u@h:~/a/../..', 'u@h:.', 'u@h:../x'])(
    'refuses %s as naming no directory under the home',
    (dest) => {
      expect(() => parseRemoteDest(dest)).toThrow(/no directory under the home/);
    },
  );

  it('normalises . and .. segments', () => {
    expect(parseRemoteDest('u@h:/srv/./a/../tradebot/').path).toBe('/srv/tradebot');
    expect(parseRemoteDest('u@h:~/a/../tradebot').path).toBe('tradebot');
  });

  it('rejects a user@host that ssh would read as an option', () => {
    expect(() => parseRemoteDest('-oProxyCommand=x@h:/p')).toThrow(/must not start with "-"/);
    expect(() => parseRemoteDest('-oX@h:/p')).toThrow(/must not start with "-"/);
  });

  it('rejects a user@host containing whitespace', () => {
    expect(() => parseRemoteDest('u@h x:/p')).toThrow(/whitespace/);
  });

  it('rejects input without a colon separator', () => {
    expect(() => parseRemoteDest('user@host/path')).toThrow(/expected user@host/);
  });

  it('rejects input without a user', () => {
    expect(() => parseRemoteDest('host:/path')).toThrow(/expected user@host/);
    expect(() => parseRemoteDest('@host:/path')).toThrow(/expected user@host/);
  });

  it('rejects input without a host', () => {
    expect(() => parseRemoteDest('user@:/path')).toThrow(/expected user@host/);
  });

  it('rejects an empty string', () => {
    expect(() => parseRemoteDest('')).toThrow(/expected user@host/);
  });
});

// ── Tests: findEnvFiles ───────────────────────────────────────────────────────

describe('findEnvFiles', () => {
  it('returns every .env file, sorted', () => {
    touch('services/vault/.env');
    touch('.env');
    touch('dev/tooling/.env');

    expect(_test_findEnvFiles(root)).toEqual([
      path.join(root, '.env'),
      path.join(root, 'dev/tooling/.env'),
      path.join(root, 'services/vault/.env'),
    ]);
  });

  it('skips node_modules, dist and dot-directories', () => {
    touch('.env');
    touch('node_modules/pkg/.env');
    touch('services/x/dist/.env');
    touch('.git/.env');
    touch('.deprecated/old/.env');
    touch('.cache/.env');

    expect(_test_findEnvFiles(root)).toEqual([path.join(root, '.env')]);
  });

  it('ignores files merely named like .env and directories named .env', () => {
    touch('.env.example');
    touch('a/.env.local');
    fs.mkdirSync(path.join(root, 'b/.env'), { recursive: true });

    expect(_test_findEnvFiles(root)).toEqual([]);
  });

  it('returns an empty array when there are none', () => {
    expect(_test_findEnvFiles(root)).toEqual([]);
  });
});

// ── Tests: sync-env run() ─────────────────────────────────────────────────────

describe('sync-env run()', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.mocked(confirm).mockResolvedValue(true);
    vi.mocked(execFileSync).mockReturnValue(undefined as any);
  });

  afterEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  it('rejects an invalid destination before touching the remote', async () => {
    touch('.env');
    vi.mocked(input).mockResolvedValue('notvalid');

    await expect(runSyncEnv(root)).rejects.toThrow(/expected user@host/);
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('refuses the filesystem root before touching the remote', async () => {
    touch('.env');
    vi.mocked(input).mockResolvedValue('u@h:/');

    await expect(runSyncEnv(root)).rejects.toThrow(/filesystem root/);
    expect(confirm).not.toHaveBeenCalled();
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('runs mkdir under umask 077, scp, then chmod 600 for each file, as argv arrays', async () => {
    touch('services/vault/.env');
    vi.mocked(input).mockResolvedValue('u@h:/remote/base');

    await runSyncEnv(root);

    const local = path.join(root, 'services/vault/.env');

    expect(calls()).toEqual([
      ['ssh', ['--', 'u@h', "umask 077 && mkdir -p -- '/remote/base/services/vault'"]],
      ['scp', ['-q', '--', local, 'u@h:/remote/base/services/vault/.env']],
      ['ssh', ['--', 'u@h', "chmod 600 -- '/remote/base/services/vault/.env'"]],
    ]);
  });

  it('quotes a remote path with spaces and quotes as one shell word', async () => {
    touch('.env');
    vi.mocked(input).mockResolvedValue("u@h:/a b/it's");

    await runSyncEnv(root);

    expect(calls()[0]).toEqual(['ssh', ['--', 'u@h', `umask 077 && mkdir -p -- '/a b/it'\\''s'`]]);
    expect(calls()[1][1][3]).toBe("u@h:/a b/it's/.env");
    expect(calls()[2]).toEqual(['ssh', ['--', 'u@h', `chmod 600 -- '/a b/it'\\''s/.env'`]]);
  });

  it('passes a bracketed IPv6 user@host through unchanged', async () => {
    touch('.env');
    vi.mocked(input).mockResolvedValue('u@[::1]:/p');

    await runSyncEnv(root);

    expect(calls()[0][1][1]).toBe('u@[::1]');
    expect(calls()[1][1][3]).toBe('u@[::1]:/p/.env');
  });

  it('copies one file per found .env file', async () => {
    touch('.env');
    touch('services/vault/.env');
    vi.mocked(input).mockResolvedValue('u@h:/remote/base');

    await runSyncEnv(root);

    expect(calls().filter(([cmd]) => cmd === 'scp')).toHaveLength(2);
  });

  it('asks before copying and makes no ssh or scp call when declined', async () => {
    touch('.env');
    vi.mocked(input).mockResolvedValue('u@h:/remote/base');
    vi.mocked(confirm).mockResolvedValue(false);

    await runSyncEnv(root);

    expect(confirm).toHaveBeenCalledWith('Overwrite 1 .env file(s) on u@h under /remote/base?', false);
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('stops without asking when no .env files are found', async () => {
    vi.mocked(input).mockResolvedValue('u@h:/remote/base');

    await runSyncEnv(root);

    expect(confirm).not.toHaveBeenCalled();
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('reports success and leaves the exit code alone when every file is copied', async () => {
    touch('.env');
    vi.mocked(input).mockResolvedValue('u@h:/remote/base');

    await runSyncEnv(root);

    expect(success).toHaveBeenLastCalledWith('Done. 1 file(s) synced to u@h:/remote/base.');
    expect(process.exitCode).toBeUndefined();
  });

  it('keeps going after a failed file, names it in the summary and sets exit code 1', async () => {
    touch('.env');
    touch('services/vault/.env');
    vi.mocked(input).mockResolvedValue('u@h:/remote/base');
    vi.mocked(execFileSync).mockImplementation(((cmd: string, args: string[]) => {
      if (cmd === 'scp' && args[3].endsWith('/services/vault/.env')) {
        throw new Error('Permission denied');
      }
      return undefined;
    }) as any);

    await runSyncEnv(root);

    expect(calls().filter(([cmd]) => cmd === 'scp')).toHaveLength(2);
    expect(error).toHaveBeenLastCalledWith(
      'Synced 1 of 2 file(s) to u@h:/remote/base; failed: services/vault/.env',
    );
    expect(success).not.toHaveBeenCalledWith(expect.stringMatching(/^Done\./));
    expect(process.exitCode).toBe(1);
  });
});
