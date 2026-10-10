import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

vi.mock('../../src/shared/ui/prompts', () => ({
  input: vi.fn(),
}));

vi.mock('../../src/shared/ui/logger', () => ({
  info: vi.fn(),
  success: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  section: vi.fn(),
}));

import { execSync } from 'node:child_process';
import { input } from '../../src/shared/ui/prompts';
import { parseRemoteDest } from '../../src/tools/remote/types';
import { _test_findEnvFiles, run as runSyncEnv } from '../../src/tools/remote/sync-env';

// ── Tests: parseRemoteDest ────────────────────────────────────────────────────

describe('parseRemoteDest', () => {
  it('parses user@host:/path', () => {
    expect(parseRemoteDest('user@host:/remote/path')).toEqual({
      userHost: 'user@host',
      path: '/remote/path',
    });
  });

  it('strips trailing slash', () => {
    expect(parseRemoteDest('user@host:/remote/path/')!.path).toBe('/remote/path');
  });

  it('preserves deep path with subdirectories', () => {
    expect(parseRemoteDest('deploy@192.168.1.1:/data/tradebot/vault')).toEqual({
      userHost: 'deploy@192.168.1.1',
      path: '/data/tradebot/vault',
    });
  });

  it('returns null when no colon separator', () => {
    expect(parseRemoteDest('user@host/path')).toBeNull();
  });

  it('returns null when no @ in host part', () => {
    expect(parseRemoteDest('host:/path')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseRemoteDest('')).toBeNull();
  });
});

// ── Tests: findEnvFiles ───────────────────────────────────────────────────────

describe('findEnvFiles', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns a sorted list of .env paths', () => {
    vi.mocked(execSync).mockReturnValue('/root/.env\n/root/services/vault/.env\n/root/dev/tooling/.env\n' as any);

    expect(_test_findEnvFiles()).toEqual([
      '/root/.env',
      '/root/dev/tooling/.env',
      '/root/services/vault/.env',
    ]);
  });

  it('filters empty lines from find output', () => {
    vi.mocked(execSync).mockReturnValue('\n/root/.env\n\n' as any);

    expect(_test_findEnvFiles()).toEqual(['/root/.env']);
  });

  it('returns empty array when find produces no output', () => {
    vi.mocked(execSync).mockReturnValue('' as any);

    expect(_test_findEnvFiles()).toEqual([]);
  });

  it('passes EXCLUDE directories to find command', () => {
    vi.mocked(execSync).mockReturnValue('' as any);
    _test_findEnvFiles();

    const cmd = String(vi.mocked(execSync).mock.calls[0][0]);

    expect(cmd).toContain('node_modules');
    expect(cmd).toContain('dist');
    expect(cmd).toContain('.git');
  });
});

// ── Tests: sync-env run() ─────────────────────────────────────────────────────

describe('sync-env run()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(process, 'exit').mockImplementation(((code: number) => {
      throw new Error(`process.exit(${code})`);
    }) as any);
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects with process.exit(1) for an invalid destination format', async () => {
    vi.mocked(input).mockResolvedValue('notvalid');

    await expect(runSyncEnv()).rejects.toThrow('process.exit(1)');
  });

  it('SCPs one file per found .env file', async () => {
    vi.mocked(input).mockResolvedValue('user@host:/remote/base');
    vi.mocked(execSync)
      .mockReturnValueOnce('/root/.env\n/root/services/vault/.env\n' as any)
      .mockReturnValue(undefined as any);

    await runSyncEnv();

    const scpCalls = vi.mocked(execSync).mock.calls.filter(([cmd]) => String(cmd).startsWith('scp'));

    expect(scpCalls).toHaveLength(2);
  });

  it('includes the remote base path in each scp destination', async () => {
    vi.mocked(input).mockResolvedValue('user@host:/remote/base');
    vi.mocked(execSync)
      .mockReturnValueOnce('/root/services/vault/.env\n' as any)
      .mockReturnValue(undefined as any);

    await runSyncEnv();

    const scpCall = String(vi.mocked(execSync).mock.calls.find(([cmd]) => String(cmd).startsWith('scp'))![0]);

    expect(scpCall).toContain('user@host:/remote/base/');
  });

  it('stops after find when no .env files are found', async () => {
    vi.mocked(input).mockResolvedValue('user@host:/remote/base');
    vi.mocked(execSync).mockReturnValueOnce('' as any);

    await runSyncEnv();

    // Only the find call — no ssh mkdir or scp
    expect(execSync).toHaveBeenCalledTimes(1);
  });

  it('creates the remote directory before each scp', async () => {
    vi.mocked(input).mockResolvedValue('user@host:/remote/base');
    vi.mocked(execSync)
      .mockReturnValueOnce('/root/.env\n' as any)
      .mockReturnValue(undefined as any);

    await runSyncEnv();

    const sshCall = String(vi.mocked(execSync).mock.calls.find(([cmd]) => String(cmd).startsWith('ssh'))![0]);

    expect(sshCall).toContain('mkdir -p');
  });
});
