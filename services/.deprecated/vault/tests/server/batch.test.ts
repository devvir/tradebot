import { describe, it, expect } from 'vitest';
import { batchLines } from '../../src/server/batch';

async function* fromLines(lines: string[]) {
  for (const l of lines) yield l;
}

const collect = async (lines: string[], size: number): Promise<string[]> => {
  const out: string[] = [];

  for await (const chunk of batchLines(fromLines(lines), size)) out.push(chunk);

  return out;
};

const ndjson = (n: number): string[] =>
  Array.from({ length: n }, (_, i) => JSON.stringify({ id: i, symbol: 'XBTUSD', price: 30000 + i }) + '\n');

describe('batchLines', () => {
  it('joins to exactly the unbatched output, in chunks that end on a line end', async () => {
    const lines  = ndjson(5_000);
    const chunks = await collect(lines, 64 * 1024);

    expect(chunks.join('')).toBe(lines.join(''));
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.length).toBeLessThan(lines.length);

    for (const chunk of chunks) expect(chunk.endsWith('\n')).toBe(true);
  });

  it('closes a chunk once it reaches the size, never splitting a line', async () => {
    expect(await collect(['aaa\n', 'bb\n', 'c\n', 'dddd\n', 'e\n'], 6)).toEqual(['aaa\nbb\n', 'c\ndddd\n', 'e\n']);
  });

  it('yields the remainder below the size and nothing for no lines', async () => {
    expect(await collect(['a\n', 'b\n'], 1024)).toEqual(['a\nb\n']);
    expect(await collect([], 1024)).toEqual([]);
  });

  it('forwards an error of the source', async () => {
    async function* failing() {
      yield 'a\n';
      throw new Error('boom');
    }

    const run = async () => { for await (const _ of batchLines(failing(), 1024)) { /* drain */ } };

    await expect(run()).rejects.toThrow('boom');
  });
});
