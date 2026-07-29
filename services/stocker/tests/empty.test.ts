import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasContent } from '../src/containers';

/**
 * Venues publish genuinely empty archives — Bybit wrote one for every symbol
 * that delisted on 2022-12-12, Gate for a symbol that listed and never traded.
 * They are valid files that inflate to nothing, and left in the file set they
 * define the schema the reader expects, so the real files are rejected against
 * it.
 */

let dir: string;

const gz = (name: string, body: string): string => {
  const path = join(dir, name);

  execFileSync('bash', ['-c', `printf '%s' ${JSON.stringify(body)} | gzip > ${JSON.stringify(path)}`]);

  return path;
};

beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'empty-')); });
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

describe('deciding whether a decoded file holds anything', () => {
  it('sees through a valid gzip that inflates to nothing', async () => {
    expect(await hasContent(gz('empty.csv.gz', ''))).toBe(false);
  });

  it('sees content in a gzip that has some', async () => {
    expect(await hasContent(gz('real.csv.gz', 'timestamp,price\n1,2\n'))).toBe(true);
  });

  /**
   * The reason this decodes rather than reading the gzip trailer: a gzip
   * records its uncompressed size in the last four bytes, and for a
   * *concatenated* gzip that describes only the final member. Data followed by
   * an empty member would read as empty and the whole month would be dropped.
   */
  it('is not fooled by data followed by an empty gzip member', async () => {
    const data  = gz('data.csv.gz', 'timestamp,price\n1,2\n');
    const blank = gz('blank.csv.gz', '');
    const both  = join(dir, 'multi.csv.gz');

    execFileSync('bash', ['-c',
      `cat ${JSON.stringify(data)} ${JSON.stringify(blank)} > ${JSON.stringify(both)}`]);

    expect(await hasContent(both)).toBe(true);
  });

  it('judges an uncompressed file by its size', async () => {
    const path = join(dir, 'plain.csv');

    await writeFile(path, '');
    expect(await hasContent(path)).toBe(false);

    await writeFile(path, 'a\n');
    expect(await hasContent(path)).toBe(true);
  });

  /**
   * Both shapes are on disk: Bybit publishes valid 42-byte gzips with an empty
   * payload, Gate leaves files of no bytes at all — which are not gzips and
   * would fail to inflate. Neither can be hiding data.
   */
  it('calls a zero-length file empty whatever its extension claims', async () => {
    const path = join(dir, 'nothing.csv.gz');

    await writeFile(path, '');

    expect(await hasContent(path)).toBe(false);
  });

  /**
   * The opposite case: bytes are there and cannot be read. Something may be
   * lost, so it must surface rather than be absorbed as "empty".
   */
  it('rejects a file that has bytes but is not valid gzip', async () => {
    const path = join(dir, 'broken.csv.gz');

    await writeFile(path, 'this is not gzip at all');

    await expect(hasContent(path)).rejects.toThrow();
  });
});
