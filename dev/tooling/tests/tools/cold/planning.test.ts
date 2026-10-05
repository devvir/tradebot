import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _test_plan as plan, _test_scan as scan } from '../../../src/tools/cold/push';
import type { Progress } from '../../../src/tools/cold/progress';
import * as record from '../../../src/tools/cold/record';
import type { DatabaseSync } from 'node:sqlite';
import type { ColdConfig, ListedSlice } from '../../../src/tools/cold/types';

/**
 * What a run decides before it packs anything: the catalog's ready partitions
 * set against the record.
 */

const GB = 1024 ** 3;

let dir:    string;
let db:     DatabaseSync;
let slices: ListedSlice[];
let asked:  { url: URL; lens: string | null }[];

const config = (): ColdConfig => ({
  sourceRoot: dir, coldRoot: dir, megaRoot: '/x', dbPath: path.join(dir, 'cold.sqlite'),
  capBytes: 5 * GB, queueTargetGb: 10, settledHours: null, catalogUrl: 'http://catalog.test', catalogToken: 't',
});

const slice = (dataset: string, partitions: ListedSlice['partitions']): ListedSlice =>
  ({ market: 'spot', dataset, variant: '', grain: 'daily', bundle: 'instrument', partitions });

const month = (at: string, gb: number, version = 'v1') => ({ month: at, files: 10, bytes: gb * GB, version });

const run = (lens: string | null = null) => plan(db, config(), 'archives', ['gate'], lens);

const tars = () => record.tarsOf(db, 'archives').map(tar =>
  `${path.basename(tar.remote)} ${tar.state}: ${record.heldIn(db, tar.id).map(one => one.dataset).join(',')}`);

beforeEach(() => {
  dir    = fs.mkdtempSync(path.join(os.tmpdir(), 'cold-plan-'));
  db     = record.open(path.join(dir, 'cold.sqlite'));
  slices = [];
  asked  = [];

  vi.stubGlobal('fetch', vi.fn(async (url: string, init: { headers: Record<string, string> }) => {
    asked.push({ url: new URL(url), lens: init.headers['x-catalog-lens'] ?? null });

    return new Response(JSON.stringify({ items: slices }), { status: 200 });
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  record.close(db);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('planning a push', () => {
  /** Only what can be acted on is asked for: downloaded, and settled. */
  it('asks the catalog for partitions that are downloaded and settled', async () => {
    await run();

    const [{ url, lens }] = asked as [typeof asked[number]];

    expect(url.pathname).toBe('/venues/gate/partitions');
    expect(url.searchParams.get('downloaded')).toBe('true');
    expect(url.searchParams.get('settled')).toBe('true');
    expect(url.searchParams.has('settled-before')).toBe(false);
    expect(lens).toBeNull();
  });

  it('asks for quiet on top where a number of hours is set', async () => {
    await plan(db, { ...config(), settledHours: 8 }, 'archives', ['gate'], null);

    const [{ url }] = asked as [typeof asked[number]];
    const quiet = Date.now() - new Date(url.searchParams.get('settled-before')!).getTime();

    expect(Math.round(quiet / 3_600_000)).toBe(8);
    expect(url.searchParams.has('settled')).toBe(false);
  });

  it('reads through a lens only where one is named', async () => {
    await run('backfill-20');

    expect(asked[0]!.lens).toBe('backfill-20');
  });

  it('plans a venue-month\'s partitions into tars of whole partitions', async () => {
    slices = [
      slice('trades', [month('202001', 3)]),
      slice('klines', [month('202001', 3)]),
      slice('books',  [month('202001', 40)]),
    ];

    expect(await run()).toMatchObject({ tars: 3, added: 3, changed: 0 });
    expect(tars()).toEqual([
      'gate-202001.001.tar planned: books',
      'gate-202001.002.tar planned: klines',
      'gate-202001.003.tar planned: trades',
    ]);
  });

  it('keeps each month in tars of its own', async () => {
    slices = [slice('trades', [month('202001', 1), month('202002', 1)])];

    await run();

    expect(tars()).toEqual(['gate-202001.001.tar planned: trades', 'gate-202002.001.tar planned: trades']);
  });

  /** A tar nothing was done for is redrawn, not kept beside a new one. */
  it('plans nothing twice', async () => {
    slices = [slice('trades', [month('202001', 1)])];

    await run();
    await run();

    expect(tars()).toEqual(['gate-202001.001.tar planned: trades']);
  });

  /** What is ready is the catalog's answer today, whatever it answered before. */
  it('drops a tar planned for partitions that are no longer ready', async () => {
    slices = [slice('trades', [month('202001', 1), month('202002', 1)])];
    await run();

    slices = [slice('trades', [month('202002', 1)])];

    expect(await run()).toMatchObject({ tars: 1, added: 1 });
    expect(tars()).toEqual(['gate-202002.001.tar planned: trades']);
  });

  /** A month gains tars as more of it becomes ready; what is stored is not repacked. */
  it('adds a tar for partitions that turn up later', async () => {
    slices = [slice('trades', [month('202001', 1)])];
    await run();

    const [first] = record.tarsOf(db, 'archives');

    record.packed(db, first!.id, 100);
    record.stored(db, first!.id, 'H:1');

    slices.push(slice('klines', [month('202001', 1)]));

    expect(await run()).toMatchObject({ tars: 1, added: 1 });
    expect(tars()).toEqual(['gate-202001.001.tar stored: trades', 'gate-202001.002.tar planned: klines']);
  });

  it('marks a stored tar to be brought back when a partition in it changed', async () => {
    slices = [slice('trades', [month('202001', 1)]), slice('klines', [month('202001', 1)])];
    await run();

    const [only] = record.tarsOf(db, 'archives');

    record.packed(db, only!.id, 100);
    record.stored(db, only!.id, 'H:1');

    slices[0]!.partitions[0]!.version = 'v2';

    expect(await run()).toMatchObject({ tars: 0, changed: 1, stale: 1 });
    expect(record.tarsOf(db, 'archives')[0]!.state).toBe('stale');

    // Seen again before it is corrected, the same change is not counted twice.
    expect(await run()).toMatchObject({ changed: 0, stale: 1 });
  });

  /** Outside the lens, still downloading, still changing: none is a reason to touch what is stored. */
  it('leaves alone a stored partition the catalog no longer answers with', async () => {
    slices = [slice('trades', [month('202001', 1)])];
    await run();

    const [only] = record.tarsOf(db, 'archives');

    record.packed(db, only!.id, 100);
    record.stored(db, only!.id, 'H:1');

    slices = [];

    expect(await run()).toMatchObject({ tars: 0, changed: 0 });
    expect(tars()).toEqual(['gate-202001.001.tar stored: trades']);
  });
});

/**
 * In watch mode the catalog is asked again while the run goes on. What that
 * says depends on whether the run had anything else to show.
 */
describe('asking again in the middle of a run', () => {
  let said:  string[];
  let sized: [number, number][];

  const progress = (): Progress => ({
    log:    (line: string) => { said.push(line); },
    resize: (total: number, done: number) => { sized.push([total, done]); },
  }) as unknown as Progress;

  const again = (busy: boolean) => scan(db, config(), 'archives', ['gate'], null, progress(), busy);

  beforeEach(() => {
    said  = [];
    sized = [];
  });

  it('shows the asking and each venue\'s answer where the run was waiting', async () => {
    slices = [slice('trades', [month('202001', 1)])];

    await again(false);

    expect(said[0]).toBe('Asking the catalog what is ready to push');
    expect(said[1]).toMatch(/gate\s+1 new partition ready to push \(10 files · 1 tar · /);
    expect(said).toHaveLength(2);
  });

  it('says nothing where the run was at work and nothing new turned up', async () => {
    slices = [slice('trades', [month('202001', 1)])];
    await run();

    await again(true);

    expect(said).toEqual([]);
  });

  /** A plan is redrawn, so what is new is counted by partition and not by tar. */
  it('says in one line what it found where the run was at work', async () => {
    slices = [slice('trades', [month('202001', 1)])];
    await run();

    slices = [slice('trades', [month('202001', 1)]), slice('klines', [month('202001', 1), month('202002', 1)])];

    await again(true);

    expect(said).toEqual(['Found 2 new partitions ready to push']);
    expect(tars()).toEqual([
      'gate-202001.001.tar planned: klines,trades',
      'gate-202002.001.tar planned: klines',
    ]);
  });

  it('counts what it found into the run', async () => {
    slices = [slice('trades', [month('202001', 1), month('202002', 1)])];

    await again(true);

    expect(sized).toEqual([[2, 0]]);
  });

  /** One scan lost, and the plan left as it was. */
  it('carries on where the catalog does not answer', async () => {
    slices = [slice('trades', [month('202001', 1)])];
    await run();

    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('connect ECONNREFUSED'); }));

    await again(true);

    expect(said).toHaveLength(1);
    expect(said[0]).toMatch(/^Could not ask the catalog: /);
    expect(tars()).toEqual(['gate-202001.001.tar planned: trades']);
  });
});
