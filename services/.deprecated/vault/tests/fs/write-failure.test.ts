import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { WriterOptions, WriteFailure } from '@devvir/zipper';

// What the writer does when zipper reports a member that failed every retry.
// zipper's writer is replaced by one that records the options it was created
// with, so a failure report can be delivered by hand.

const data = vi.hoisted(() => ({ dir: '/nonexistent-vault-test-dir', options: [] as WriterOptions[] }));

vi.mock('@devvir/zipper', () => ({
  createWriter: (_path: string, options: WriterOptions) => {
    data.options.push(options);

    return { write: async () => {}, close: async () => {} };
  },
}));

vi.mock('../../src/fs/paths', () => {
  const dataDir    = () => data.dir;
  const tableDir   = (table: string) => path.join(dataDir(), table);
  const yearDir    = (table: string, filename: string) => path.join(tableDir(table), filename.slice(0, 4));
  const openPath   = (table: string, filename: string) => path.join(yearDir(table, filename), `${filename}.csv.gz.tmp`);
  const closedPath = (table: string, filename: string) => path.join(yearDir(table, filename), `${filename}.csv.gz`);

  return { get DATA_DIR() { return dataDir(); }, tableDir, yearDir, openPath, closedPath };
});

vi.mock('../../src/fs/health', () => ({
  recordFailure:   vi.fn(),
  setBackpressure: vi.fn(),
}));

import { logger } from '@devvir/service-kit';
import { appendBatch, _test_reset as resetWriter } from '../../src/fs/writer';
import { recordFailure } from '../../src/fs/health';
import { closedPath } from '../../src/fs/paths';

const failure = (extra: Partial<WriteFailure> = {}): WriteFailure => ({
  path:           closedPath('trade', '20240101'),
  recovery:       'auto',
  bytesDropped:   512,
  lastGoodOffset: 1024,
  error:          new Error('EIO: i/o error, write'),
  ...extra,
});

/** Opens the writer for trade/20240101 and returns the failure callback zipper was given. */
const reportFailure = async (): Promise<(info: WriteFailure) => void> => {
  await appendBatch('trade', '20240101', ['header']);

  return data.options[0]!.onWriteFailure!;
};

beforeEach(() => {
  data.dir     = mkdirSync(path.join(os.tmpdir(), `vault-write-failure-test-${Date.now()}-${Math.random()}`), { recursive: true }) as string;
  data.options = [];
  resetWriter();
  vi.clearAllMocks();
});

afterEach(() => {
  rmSync(data.dir, { recursive: true, force: true });
});

describe('a member dropped after every retry', () => {
  it('counts toward storage health and writes no sidecar', async () => {
    (await reportFailure())(failure());

    expect(recordFailure).toHaveBeenCalledTimes(1);
    expect(vi.mocked(recordFailure).mock.calls[0]![0]).toMatch(/trade\/20240101/);
    expect(existsSync(`${closedPath('trade', '20240101')}.error`)).toBe(false);
  });
});

describe('a member whose truncate-back also failed', () => {
  const quarantinePath = (): string => `${closedPath('trade', '20240101')}.tmp.failed.1`;

  it('logs at error level, counts toward storage health and writes an .error sidecar naming the quarantined file', async () => {
    (await reportFailure())(failure({
      recovery:       'safe',
      truncateError:  new Error('EIO: i/o error, ftruncate'),
      quarantinePath: quarantinePath(),
    }));

    const sidecar = JSON.parse(readFileSync(`${closedPath('trade', '20240101')}.error`, 'utf8'));

    expect(sidecar).toMatchObject({ lastGoodOffset: 1024, quarantinePath: quarantinePath(), reappendError: null });
    expect(sidecar.writeError).toMatch(/write/);
    expect(sidecar.truncateError).toMatch(/ftruncate/);
    expect(sidecar.note).toContain(quarantinePath());

    expect(recordFailure).toHaveBeenCalledTimes(1);
    expect(vi.mocked(recordFailure).mock.calls[0]![0]).toMatch(/trade\/20240101/);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ table: 'trade', filename: '20240101', quarantinePath: quarantinePath(), lastGoodOffset: 1024 }),
      expect.stringMatching(/quarantined/),
    );
  });

  it('records a failed re-append in the log and the sidecar', async () => {
    const reappendError = new Error('EIO: i/o error, reappend');

    (await reportFailure())(failure({
      recovery:       'safe',
      truncateError:  new Error('EIO: i/o error, ftruncate'),
      quarantinePath: quarantinePath(),
      reappendError,
    }));

    const sidecar = JSON.parse(readFileSync(`${closedPath('trade', '20240101')}.error`, 'utf8'));

    expect(sidecar.reappendError).toMatch(/reappend/);
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ reappendError }), expect.stringMatching(/quarantined/));
  });

  it('logs a sidecar that cannot be written, and still counts toward storage health', async () => {
    const report = await reportFailure();

    // The sidecar's directory is a file, so the sidecar cannot be created.
    rmSync(path.dirname(closedPath('trade', '20240101')), { recursive: true, force: true });
    writeFileSync(path.dirname(closedPath('trade', '20240101')), '');

    report(failure({
      recovery:       'safe',
      truncateError:  new Error('EIO: i/o error, ftruncate'),
      quarantinePath: quarantinePath(),
    }));

    expect(recordFailure).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ errPath: `${closedPath('trade', '20240101')}.error` }),
      expect.stringMatching(/sidecar/),
    );
  });
});
