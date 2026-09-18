import { describe, expect, it } from 'vitest';
import { descend } from '../src/scanners/descend';
import type { Level, ListingContext } from '../src/types';

/** Mapping an archive: how many partitions, and how the directories are asked. See `descend.ts`. */
describe('mapping an archive', () => {
  const context = { name: 'fake', base: 'https://x', keyRoot: '' } as unknown as ListingContext;

  /** A root with thirty symbol directories, each holding files of its own. */
  const tree = (path: string): Level => path === ''
    ? { children: Array.from({ length: 30 }, (_, i) => `S${i}/`), files: false }
    : { children: [], files: true };

  it('asks the directories it has not read together, not one after another', async () => {
    let open = 0;
    let most = 0;

    const read = async (_context: ListingContext, prefix: string): Promise<Level> => {
      most = Math.max(most, ++open);
      await new Promise(done => setTimeout(done, 5));
      open--;

      return tree(prefix);
    };

    const scopes = await descend(context, { concurrency: 100 }, read);

    expect(scopes).toHaveLength(30);
    expect(most).toBe(30);
  });

  it('reads no more at once than the room left before there is enough work', async () => {
    let most = 0;
    let open = 0;

    const read = async (_context: ListingContext, prefix: string): Promise<Level> => {
      most = Math.max(most, ++open);
      await new Promise(done => setTimeout(done, 5));
      open--;

      return tree(prefix);
    };

    await descend(context, { concurrency: 40 }, read);

    expect(most).toBeLessThanOrEqual(40 - 30);
  });

  /** Thirty directories read together, each with ten children: split only until there is enough. */
  it('stops splitting once there is enough work', async () => {
    const wide = (path: string): Level => path === ''
      ? { children: Array.from({ length: 30 }, (_, i) => `S${i}/`), files: false }
      : path.split('/').length === 2
        ? { children: Array.from({ length: 10 }, (_, i) => `${path}${i}/`), files: false }
        : { children: [], files: true };

    const scopes = await descend(context, { concurrency: 50 }, async (_context, prefix) => wide(prefix));

    expect(scopes.length).toBeGreaterThanOrEqual(50);
    expect(scopes.length).toBeLessThan(50 + 10);
  });
});
