import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchText } from '../src/http';
import { listing } from '../src/context';
import { html, _test_isDirectory, _test_known, _test_next, _test_parse } from '../src/scanners/html';
import type { Adapter } from '../src/types';

/** The scanner is the only thing here that talks to a venue, so the wire is stubbed. */
vi.mock('../src/http', () => ({ fetchText: vi.fn(), fetchHead: vi.fn() }));

/**
 * A venue of this shape, declared here rather than borrowed from a real one.
 *
 * **A scanner is infrastructure, not a venue's property.** Venues arrive over
 * time and change how they are surveyed — bybit was on this scanner until its
 * bucket turned out to answer a listing API — and a scanner's tests should not
 * move when that happens. So the fixture is the *kind* of venue this code
 * exists for: browsable indexes, no metadata in a listing, dates in filenames.
 */
const indexed: Adapter = {
  getContext: async () => listing(indexed),
  name:    'indexed',
  scanner: html,
  list:    'https://indexes.example',
  base:    'https://indexes.example',
  root:    '',
  probes:  true,
  dateOf:  (path) => /(\d{4})-(\d{2})-(\d{2})/.exec(path)?.slice(1).join('') ?? null,
};

/** What the core would hand the scanner: this venue's addresses and a paced fetcher. */
const context = listing(indexed);

/** One flavour: directories carry a trailing slash. */
const slashed = (names: string[]) => `<html><body><h1>Directory listing</h1><hr><ul>
${names.map(n => `<li><a href="${n}">${n}</a></li>`).join('\n')}
</ul><hr></body></html>`;

/** The other: the same page, and directories without the slash. */
const bare = (names: string[]) => `<html><body><ul>
${names.map(n => `\n    <li><a href="${n}">${n}</a></li>\n`).join('')}
</ul></body></html>`;

/** Serve a tree of directories, and an empty page for anything not in it. */
const serving = (tree: Record<string, string[]>) =>
  vi.mocked(fetchText).mockImplementation(async (_adapter: Adapter, url: string) => {
    const at = url.replace('https://indexes.example/', '');

    return slashed(tree[at] ?? []);
  });

beforeEach(() => _test_known.clear());
afterEach(() => vi.mocked(fetchText).mockReset());

describe('reading an index page', () => {
  it('takes the entries from the links, whatever the page around them', () => {
    const entries = _test_parse(slashed(['BTCUSDT/', 'ETHUSDT/']), 'trading/');

    expect(entries.children).toEqual(['trading/BTCUSDT/', 'trading/ETHUSDT/']);
    expect(entries.keys).toEqual([]);
  });

  it('reads the flavour that omits the trailing slash', () => {
    const entries = _test_parse(bare(['BTCUSDT', 'ETHUSDT']), 'spot/');

    expect(entries.children).toEqual(['spot/BTCUSDT/', 'spot/ETHUSDT/']);
  });

  it('resolves a name against the directory it was found in', () => {
    const entries = _test_parse(slashed(['BTCUSDT2020-03-25.csv.gz']), 'trading/BTCUSDT/');

    expect(entries.keys).toEqual(['trading/BTCUSDT/BTCUSDT2020-03-25.csv.gz']);
  });

  /** A parent link would walk the tree upwards for ever. */
  it('ignores links that leave the directory', () => {
    const entries = _test_parse(
      `<a href="../">up</a><a href="/">root</a><a href="https://x/y">off</a><a href="A/">A/</a>`,
      'trading/',
    );

    expect(entries.children).toEqual(['trading/A/']);
  });

  it('decodes what a server escaped', () => {
    const entries = _test_parse('<a href="BTC%20USDT/">x</a><a href="A&amp;B/">y</a>', 'spot/');

    expect(entries.children).toEqual(['spot/BTC USDT/', 'spot/A&B/']);
  });
});

/**
 * With one tree marking directories and another not, the link's shape is
 * all there is to go on. A directory misread as a file costs a whole subtree.
 */
describe('telling a directory from a file', () => {
  it('trusts a trailing slash', () => {
    expect(_test_isDirectory('BTCUSDT/')).toBe(true);
  });

  it('reads an extension as a file', () => {
    expect(_test_isDirectory('BTCUSDT2020-03-25.csv.gz')).toBe(false);
    expect(_test_isDirectory('BTCUSDT-2022-11.csv.gz')).toBe(false);
  });

  it('reads a bare name as a directory', () => {
    expect(_test_isDirectory('BTCUSDT')).toBe(true);
    expect(_test_isDirectory('2020')).toBe(true);
  });
});

/**
 * Depth-first with sorted children visits paths in the order they sort, so the
 * directory just read is the whole of a walk's state — everything at or below it
 * is done, and the next page is the first directory above it.
 */
describe('walking a tree by cursor', () => {
  const tree = {
    'trading/':        ['AAA/', 'BBB/', 'CCC/'],
    'trading/AAA/':    ['x/'],
    'trading/AAA/x/':  [],
    'trading/BBB/':    [],
    'trading/CCC/':    [],
  };

  it('starts at the scope itself, since files can sit in it', async () => {
    serving(tree);

    expect(await _test_next(context, 'trading/', null)).toBe('trading/');
  });

  it('visits a subtree before the next sibling', async () => {
    serving(tree);

    expect(await _test_next(context, 'trading/', 'trading/')).toBe('trading/AAA/');
    expect(await _test_next(context, 'trading/', 'trading/AAA/')).toBe('trading/AAA/x/');
    expect(await _test_next(context, 'trading/', 'trading/AAA/x/')).toBe('trading/BBB/');
  });

  it('reports the end of the scope', async () => {
    serving(tree);

    expect(await _test_next(context, 'trading/', 'trading/CCC/')).toBeNull();
  });

  /** A restart resumes from one short string, with no record of what came before. */
  it('resumes into the middle of a tree it has never seen', async () => {
    serving(tree);

    expect(await _test_next(context, 'trading/', 'trading/BBB/')).toBe('trading/CCC/');
  });

  it('does not open a subtree that ends before the cursor', async () => {
    serving(tree);

    await _test_next(context, 'trading/', 'trading/BBB/');

    expect(vi.mocked(fetchText).mock.calls.map(call => call[1]))
      .not.toContain('https://indexes.example/trading/AAA/');
  });
});

describe('paging a partition', () => {
  const tree = {
    'spot/':        ['AAAUSDT/', 'BBBUSDT/'],
    'spot/AAAUSDT/': ['AAAUSDT-2022-11.csv.gz', 'AAAUSDT_2026-08-03.csv.gz'],
    'spot/BBBUSDT/': ['BBBUSDT-2023-01.csv.gz'],
  };

  it('returns one directory of files at a time, in order', async () => {
    serving(tree);

    const first = await html.page(context, 'spot/', null);

    expect(first.listed).toEqual([]);
    expect(first.cursor).toBe('spot/');

    const second = await html.page(context, 'spot/', first.cursor);

    expect(second.listed.map(entry => entry.key)).toEqual([
      'spot/AAAUSDT/AAAUSDT-2022-11.csv.gz',
      'spot/AAAUSDT/AAAUSDT_2026-08-03.csv.gz',
    ]);
    expect(second.cursor).toBe('spot/AAAUSDT/');
  });

  /** The walk ends on the last directory rather than on an empty page after it. */
  it('ends without a page nobody needed', async () => {
    serving(tree);

    const last = await html.page(context, 'spot/', 'spot/AAAUSDT/');

    expect(last.listed.map(entry => entry.key)).toEqual(['spot/BBBUSDT/BBBUSDT-2023-01.csv.gz']);
    expect(last.cursor).toBeNull();
  });

  /**
   * An index says a file is there and nothing else. Settling size and checksum
   * would be a HEAD per file, which is a different scanner's job.
   */
  it('records what an index knows, and claims nothing it does not', async () => {
    serving(tree);

    const page = await html.page(context, 'spot/BBBUSDT/', null);

    expect(page.listed[0]).toEqual({
      key:      'spot/BBBUSDT/BBBUSDT-2023-01.csv.gz',
      size:     null,
      etag:     null,
      modified: null,
    });
  });

  /** Every directory costs one request, however often the walk asks about it. */
  it('reads each directory once', async () => {
    serving(tree);

    let cursor: string | null = null;

    do {
      const page: { cursor: string | null } = await html.page(context, 'spot/', cursor);

      cursor = page.cursor;
    } while (cursor);

    expect(vi.mocked(fetchText).mock.calls.map(call => call[1])).toEqual([
      'https://indexes.example/spot/',
      'https://indexes.example/spot/AAAUSDT/',
      'https://indexes.example/spot/BBBUSDT/',
    ]);
  });
});

describe('mapping an index venue', () => {
  const archive = {
    '':        ['trading/', 'spot/'],
    'trading/': Array.from({ length: 40 }, (_, i) => `SYM${i}/`),
    'spot/':    ['AAAUSDT/', 'BBBUSDT/'],
    'spot/AAAUSDT/': ['AAAUSDT-2022-11.csv.gz'],
    'spot/BBBUSDT/': ['BBBUSDT-2023-01.csv.gz'],
  };

  /**
   * The trees are found rather than declared, exactly as on an S3 venue — and
   * the mapping stops as soon as there is work for every lane rather than at any
   * rule about what a level means.
   */
  it('splits only until there is a partition for every lane', async () => {
    serving(archive);

    expect(await html.scopes(context, { concurrency: 2 }))
      .toEqual(['spot/', 'trading/']);
  });

  /** More lanes, more splitting — the same archive carved finer. */
  it('splits further when there are more lanes to fill', async () => {
    serving(archive);

    const scopes = await html.scopes(context, { concurrency: 8 });

    expect(scopes.length).toBeGreaterThan(2);
    expect(scopes).toContain('spot/AAAUSDT/');
  });

  /**
   * A prefix whose children are files is not split, so a shallow archive yields
   * fewer partitions than lanes rather than being asked about for ever.
   */
  it('stops at a prefix holding files, however many lanes are idle', async () => {
    serving({ '': ['spot/'], 'spot/': ['a-2022-11.csv.gz'] });

    expect(await html.scopes(context, { concurrency: 64 })).toEqual(['spot/']);
  });
});

/**
 * A walk moves forward through paths in byte order and never looks back, so a
 * child arriving out of that order is skipped for good — silently, while the job
 * still closes as established. The order is therefore imposed rather than
 * assumed, and no index has to promise anything.
 */
describe('a server that sorts differently than we compare', () => {
  /**
   * Bybit's own case: it sorts by the bare name, a child is compared as a path
   * with its trailing slash, and `-` sorts before `/`. So `BTCUSDT/` is served
   * before `BTCUSDT-01AUG25/` while as paths the two are the other way round.
   */
  const served = ['BTCUSDM26/', 'BTCUSDT/', 'BTCUSDT-01AUG25/', 'BTCUSDT-02JAN26/', 'BTCUSDU25/'];

  it('visits every directory whatever order they arrive in', async () => {
    serving({
      'trading/': served,
      ...Object.fromEntries(served.map(name => [`trading/${name}`, [`${name.slice(0, -1)}2025-01-01.csv.gz`]])),
    });

    let cursor: string | null = null;

    do {
      const page: { cursor: string | null } = await html.page(context, 'trading/', cursor);

      cursor = page.cursor;
    } while (cursor);

    // What was actually read, rather than what the walk reported: the last
    // directory of a scope ends the walk and so hands back no cursor.
    const visited = vi.mocked(fetchText).mock.calls
      .map(call => call[1].replace('https://indexes.example/', ''));

    expect(visited).toEqual([
      'trading/',
      'trading/BTCUSDM26/',
      'trading/BTCUSDT-01AUG25/',
      'trading/BTCUSDT-02JAN26/',
      'trading/BTCUSDT/',
      'trading/BTCUSDU25/',
    ]);
  });

  it('leaves nothing behind the cursor', async () => {
    serving({ 'trading/': served });

    const at = await _test_next(context, 'trading/', 'trading/BTCUSDM26/');

    expect(at).toBe('trading/BTCUSDT-01AUG25/');
  });
});
