import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
  spacer: vi.fn(),
}));

import { execSync } from 'node:child_process';
import { input } from '../../src/shared/ui/prompts';
import { parseRemoteDest } from '../../src/tools/remote/types';
import { _test_findEnvFiles, run as runSyncEnv } from '../../src/tools/remote/sync-env';
import { _test_localMd5, _test_listRemoteFiles, run as runPull } from '../../src/tools/remote/pull';

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

// ── Tests: listRemoteFiles ────────────────────────────────────────────────────

describe('listRemoteFiles', () => {
  beforeEach(() => vi.clearAllMocks());

  it('parses md5sum lines into checksum + path pairs', () => {
    vi.mocked(execSync).mockReturnValue(
      'abc123def456789012345678901234ab  /remote/path/file.csv\ndef456abc123789012345678901234cd  /remote/path/sub/other.csv\n' as any
    );

    const files = _test_listRemoteFiles({ userHost: 'user@host', path: '/remote/path' });

    expect(files).toHaveLength(2);
    expect(files[0]).toEqual({
      checksum: 'abc123def456789012345678901234ab',
      remotePath: '/remote/path/file.csv',
    });
    expect(files[1].remotePath).toBe('/remote/path/sub/other.csv');
  });

  it('skips malformed lines without double-space separator', () => {
    vi.mocked(execSync).mockReturnValue('malformed-no-separator\nabc123  /valid/path.csv\n' as any);

    const files = _test_listRemoteFiles({ userHost: 'user@host', path: '/remote' });

    expect(files).toHaveLength(1);
    expect(files[0].remotePath).toBe('/valid/path.csv');
  });

  it('returns empty array for empty ssh output', () => {
    vi.mocked(execSync).mockReturnValue('' as any);

    expect(_test_listRemoteFiles({ userHost: 'user@host', path: '/remote' })).toHaveLength(0);
  });

  it('invokes ssh with the correct host and remote path', () => {
    vi.mocked(execSync).mockReturnValue('' as any);
    _test_listRemoteFiles({ userHost: 'deploy@10.0.0.1', path: '/data/vault' });

    const cmd = String(vi.mocked(execSync).mock.calls[0][0]);

    expect(cmd).toContain('ssh "deploy@10.0.0.1"');
    expect(cmd).toContain('/data/vault');
  });
});

// ── Tests: localMd5 ───────────────────────────────────────────────────────────

describe('localMd5', () => {
  let tmpFile: string;

  beforeEach(() => {
    tmpFile = path.join(os.tmpdir(), `remote-test-${Date.now()}`);
  });

  afterEach(() => {
    if (fs.existsSync(tmpFile)) {
      fs.unlinkSync(tmpFile);
    }
  });

  it('returns the md5 of a file', () => {
    fs.writeFileSync(tmpFile, 'hello');

    // md5('hello') = 5d41402abc4b2a76b9719d911017c592
    expect(_test_localMd5(tmpFile)).toBe('5d41402abc4b2a76b9719d911017c592');
  });

  it('returns null for a missing file', () => {
    expect(_test_localMd5('/nonexistent/path/file.txt')).toBeNull();
  });

  it('returns different checksums for different content', () => {
    fs.writeFileSync(tmpFile, 'content-a');
    const hashA = _test_localMd5(tmpFile);

    fs.writeFileSync(tmpFile, 'content-b');
    const hashB = _test_localMd5(tmpFile);

    expect(hashA).not.toBe(hashB);
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

// ── Tests: pull run() ─────────────────────────────────────────────────────────

describe('pull run()', () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(process, 'exit').mockImplementation(((code: number) => {
      throw new Error(`process.exit(${code})`);
    }) as any);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pull-test-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('rejects with process.exit(1) for an invalid source format', async () => {
    vi.mocked(input).mockResolvedValue('notvalid');

    await expect(runPull()).rejects.toThrow('process.exit(1)');
  });

  it('rejects with process.exit(1) when SSH listing fails', async () => {
    vi.mocked(input)
      .mockResolvedValueOnce('user@host:/remote')
      .mockResolvedValueOnce(tmpDir);
    vi.mocked(execSync).mockImplementation(() => {
      throw new Error('ssh: Connection refused');
    });

    await expect(runPull()).rejects.toThrow('process.exit(1)');
  });

  it('reports all files up to date when checksums match', async () => {
    const localFile = path.join(tmpDir, 'existing.csv');
    fs.writeFileSync(localFile, 'hello');

    vi.mocked(input)
      .mockResolvedValueOnce('user@host:/remote')
      .mockResolvedValueOnce(tmpDir);
    vi.mocked(execSync)
      .mockReturnValueOnce('5d41402abc4b2a76b9719d911017c592  /remote/existing.csv\n' as any)
      .mockReturnValue(undefined as any);

    await runPull();

    const scpCalls = vi.mocked(execSync).mock.calls.filter(([cmd]) => String(cmd).startsWith('scp'));

    expect(scpCalls).toHaveLength(0);
  });

  it('pulls a file that is missing locally', async () => {
    vi.mocked(input)
      .mockResolvedValueOnce('user@host:/remote')
      .mockResolvedValueOnce(tmpDir);
    vi.mocked(execSync)
      .mockReturnValueOnce('abc123def456789012345678901234ab  /remote/new-file.csv\n' as any)
      .mockReturnValue(undefined as any);

    await runPull();

    const scpCalls = vi.mocked(execSync).mock.calls.filter(([cmd]) => String(cmd).startsWith('scp'));

    expect(scpCalls).toHaveLength(1);
    expect(String(scpCalls[0][0])).toContain('new-file.csv');
  });

  it('pulls a file whose checksum differs from the local copy', async () => {
    const localFile = path.join(tmpDir, 'changed.csv');
    fs.writeFileSync(localFile, 'old-content');

    vi.mocked(input)
      .mockResolvedValueOnce('user@host:/remote')
      .mockResolvedValueOnce(tmpDir);
    vi.mocked(execSync)
      .mockReturnValueOnce('deadbeef12345678901234567890abcd  /remote/changed.csv\n' as any)
      .mockReturnValue(undefined as any);

    await runPull();

    const scpCalls = vi.mocked(execSync).mock.calls.filter(([cmd]) => String(cmd).startsWith('scp'));

    expect(scpCalls).toHaveLength(1);
    expect(String(scpCalls[0][0])).toContain('changed.csv');
  });

  it('pulls missing files but skips identical ones in the same batch', async () => {
    const identicalFile = path.join(tmpDir, 'same.csv');
    fs.writeFileSync(identicalFile, 'hello');

    vi.mocked(input)
      .mockResolvedValueOnce('user@host:/remote')
      .mockResolvedValueOnce(tmpDir);
    vi.mocked(execSync)
      .mockReturnValueOnce(
        '5d41402abc4b2a76b9719d911017c592  /remote/same.csv\n' +
        'abc123def456789012345678901234ab  /remote/new.csv\n' as any
      )
      .mockReturnValue(undefined as any);

    await runPull();

    const scpCalls = vi.mocked(execSync).mock.calls.filter(([cmd]) => String(cmd).startsWith('scp'));

    expect(scpCalls).toHaveLength(1);
    expect(String(scpCalls[0][0])).toContain('new.csv');
  });
});
