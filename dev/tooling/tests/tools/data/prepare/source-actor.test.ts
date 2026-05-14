import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createSourceActor } from '../../../../src/tools/data/prepare/source-actor';
import { _test_setColumns, _test_clearColumns } from '../../../../src/tools/data/tables';
import type { PreparedMessage, ReadIssue } from '../../../../src/tools/data/prepare/types';

const COLUMNS = ['_date_', '_action_', 'timestamp', 'symbol', 'price'];

describe('createSourceActor', () => {
  // 'orderBookL2' → fixedPartials=false, has timestamp column
  beforeAll(() => { _test_setColumns('orderBookL2', COLUMNS); });
  afterAll(()  => { _test_clearColumns('orderBookL2'); });

  function writeGz(content: string): string {
    const dir  = fs.mkdtempSync(path.join(os.tmpdir(), 'source-actor-'));
    const file = path.join(dir, 'in.csv.gz');

    fs.writeFileSync(file, zlib.gzipSync(content));

    return file;
  }

  async function collect(gen: AsyncGenerator<PreparedMessage[]>): Promise<PreparedMessage[]> {
    const out: PreparedMessage[] = [];

    for await (const batch of gen) {
      out.push(...batch);
    }

    return out;
  }

  it('reads, sorts, and yields messages', async () => {
    const file = writeGz([
      COLUMNS.join(','),
      '2026-01-01T12:00:30.000Z,update,2026-01-01T12:00:30.000Z,XBT,103',
      '2026-01-01T12:00:10.000Z,update,2026-01-01T12:00:10.000Z,XBT,101',
      '2026-01-01T12:00:20.000Z,update,2026-01-01T12:00:20.000Z,XBT,102',
    ].join('\n') + '\n');

    const issues: ReadIssue[] = [];
    const all = await collect(createSourceActor('orderBookL2', file, i => issues.push(i)));

    expect(issues).toEqual([]);
    expect(all.map(m => m.ts)).toEqual([
      '2026-01-01T12:00:10.000',
      '2026-01-01T12:00:20.000',
      '2026-01-01T12:00:30.000',
    ]);
  });

  it('yields evicted buckets in order across minute boundaries', async () => {
    // Two minutes of data, in-order, plenty under sort threshold — flush
    // delivers them in chronological key order.
    const lines = [COLUMNS.join(',')];

    for (let m = 0; m < 2; m++) {
      for (let s = 0; s < 5; s++) {
        const t = `2026-01-01T12:0${m}:0${s}.000Z`;

        lines.push(`${t},update,${t},XBT,${m * 10 + s}`);
      }
    }

    const file = writeGz(lines.join('\n') + '\n');
    const all = await collect(createSourceActor('orderBookL2', file, () => {}));

    expect(all).toHaveLength(10);
    expect(all[0]!.ts).toBe('2026-01-01T12:00:00.000');
    expect(all[9]!.ts).toBe('2026-01-01T12:01:04.000');
  });
});
