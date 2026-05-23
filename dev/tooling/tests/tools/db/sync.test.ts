import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the mega helper so tests don't shell out to `mega-ls`.
vi.mock('../../../src/tools/db/utils/mega', () => ({
  listMegaDirSized: vi.fn(),
  posixJoin: (...parts: string[]) => parts.join('/').replace(/\/+/g, '/'),
}));

import { syncStatesForCollections, listLocalCollections } from '../../../src/tools/db/utils/sync';
import { listMegaDirSized } from '../../../src/tools/db/utils/mega';

// ─── syncStatesForCollections ──────────────────────────────────────────────────

describe('syncStatesForCollections', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-test-'));
    vi.mocked(listMegaDirSized).mockResolvedValue(new Map());
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  function writeArchive(collection: string, filename: string, size: number): void {
    const dir = path.join(tmpDir, collection);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, filename), Buffer.alloc(size));
  }

  it('returns empty when no collections are scanned', async () => {
    expect(await syncStatesForCollections([], tmpDir, null)).toEqual([]);
  });

  it('returns local-only states when mega is null', async () => {
    writeArchive('quote', '2024.archive.gz', 100);

    const states = await syncStatesForCollections(['quote'], tmpDir, null);

    expect(states).toHaveLength(1);
    expect(states[0]).toMatchObject({
      collection: 'quote',
      file:       '2024.archive.gz',
      local:      { size: 100 },
      mega:       null,
    });
  });

  it('returns mega-only states when outDir is null', async () => {
    vi.mocked(listMegaDirSized).mockResolvedValue(new Map([['2024.archive.gz', 200]]));

    const states = await syncStatesForCollections(['quote'], null, 'mega:/base');

    expect(states).toHaveLength(1);
    expect(states[0]).toMatchObject({
      collection: 'quote',
      file:       '2024.archive.gz',
      local:      null,
      mega:       { path: 'mega:/base/quote/2024.archive.gz', size: 200 },
    });
  });

  it('joins matching files from both sides into one state', async () => {
    writeArchive('quote', '2024.archive.gz', 100);
    vi.mocked(listMegaDirSized).mockResolvedValue(new Map([['2024.archive.gz', 100]]));

    const states = await syncStatesForCollections(['quote'], tmpDir, 'mega:/base');

    expect(states).toHaveLength(1);
    expect(states[0].local).not.toBeNull();
    expect(states[0].mega).not.toBeNull();
  });

  it('excludes .tmp files (forensic markers, not real archives)', async () => {
    writeArchive('quote', '2024.archive.gz', 100);
    writeArchive('quote', '2025.archive.gz.tmp', 100);

    const states = await syncStatesForCollections(['quote'], tmpDir, null);

    expect(states.map(s => s.file)).toEqual(['2024.archive.gz']);
  });

  it('excludes files that do not match the canonical archive pattern', async () => {
    writeArchive('quote', 'random.archive.gz', 100);
    writeArchive('quote', '2024.archive.gz', 100);

    const states = await syncStatesForCollections(['quote'], tmpDir, null);

    expect(states.map(s => s.file)).toEqual(['2024.archive.gz']);
  });

  it('omits files only present in mega when they fail the canonical pattern', async () => {
    vi.mocked(listMegaDirSized).mockResolvedValue(new Map([
      ['2024.archive.gz', 100],
      ['random.archive.gz', 200],
    ]));

    const states = await syncStatesForCollections(['quote'], null, 'mega:/base');

    expect(states.map(s => s.file)).toEqual(['2024.archive.gz']);
  });

  it('sorts by collection then file', async () => {
    writeArchive('trade', '2025.archive.gz', 1);
    writeArchive('trade', '2024.archive.gz', 1);
    writeArchive('quote', '2024.archive.gz', 1);

    const states = await syncStatesForCollections(['trade', 'quote'], tmpDir, null);

    expect(states.map(s => `${s.collection}/${s.file}`)).toEqual([
      'quote/2024.archive.gz',
      'trade/2024.archive.gz',
      'trade/2025.archive.gz',
    ]);
  });

  it('emits one state per file when present on both sides with different sizes', async () => {
    writeArchive('quote', '2024.archive.gz', 100);
    vi.mocked(listMegaDirSized).mockResolvedValue(new Map([['2024.archive.gz', 200]]));

    const states = await syncStatesForCollections(['quote'], tmpDir, 'mega:/base');

    expect(states).toHaveLength(1);
    expect(states[0].local!.size).toBe(100);
    expect(states[0].mega!.size).toBe(200);
  });

  it('produces absolute local paths joined from outDir', async () => {
    writeArchive('quote', '2024.archive.gz', 100);

    const [state] = await syncStatesForCollections(['quote'], tmpDir, null);

    expect(state.local!.path).toBe(path.join(tmpDir, 'quote', '2024.archive.gz'));
  });
});

// ─── listLocalCollections ──────────────────────────────────────────────────────

describe('listLocalCollections', () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-test-')); });
  afterEach(()  => { fs.rmSync(tmpDir, { recursive: true, force: true });           });

  it('returns empty for a missing dir', () => {
    expect(listLocalCollections('/no/such/path-for-sync-test')).toEqual([]);
  });

  it('returns subdirectory names, sorted, files excluded', () => {
    fs.mkdirSync(path.join(tmpDir, 'trade'));
    fs.mkdirSync(path.join(tmpDir, 'quote'));
    fs.writeFileSync(path.join(tmpDir, 'notadir.txt'), '');

    expect(listLocalCollections(tmpDir)).toEqual(['quote', 'trade']);
  });
});
