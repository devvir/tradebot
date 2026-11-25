import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { extractInto } from '../src/containers/extract';
import { Pool } from '../src/containers/pool';
import type { Wrapped } from '../src/containers/types';

/**
 * Extraction on threads of its own answers what it answers on the main thread,
 * and a thread that dies costs only the extraction it was doing.
 *
 * The thread runs compiled code, which the tests do not have, so the
 * containers are compiled here — into a directory inside the service's own
 * `node_modules`, where the thread finds the libraries they load. The thread
 * itself is the real one behind a shim that, asked to, kills it the two ways
 * a thread dies — exiting, and throwing — or says which thread it is.
 */

const SOURCE = join(__dirname, '../src/containers');

let built: string;
let dir:   string;
let shim:  string;

const zipOf = (name: string, members: Record<string, string>): string => {
  const from = join(dir, `${name}.d`);
  const path = join(dir, name);

  mkdirSync(from, { recursive: true });

  for (const [member, body] of Object.entries(members)) writeFileSync(join(from, member), body);

  execFileSync('zip', ['-q', path, ...Object.keys(members)], { cwd: from });

  return path;
};

/** What each archive became, by name and contents, wherever it was written. */
const contents = (paths: string[][]): [string, string][][] =>
  paths.map(list => list.map(path => [basename(path), readFileSync(path, 'utf8')]));

const fresh = async (name: string): Promise<string> => {
  const at = join(dir, name);

  await mkdir(at, { recursive: true });

  return at;
};

beforeAll(async () => {
  dir   = await mkdtemp(join(tmpdir(), 'pool-'));
  built = await mkdtemp(join(__dirname, '../node_modules/.pool-test-'));

  for (const file of readdirSync(SOURCE).filter(name => name.endsWith('.ts') && name !== 'index.ts')) {
    const { outputText } = ts.transpileModule(readFileSync(join(SOURCE, file), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    });

    writeFileSync(join(built, file.replace(/\.ts$/, '.js')), outputText);
  }

  shim = join(built, 'shim.js');

  writeFileSync(shim, `
    const { parentPort, threadId } = require('node:worker_threads');
    const on = parentPort.on.bind(parentPort);

    // Ahead of the real thread's handler: some asks it never sees.
    parentPort.on = (event, handler) => on(event, asked => {
      if (asked.dir === '<exit>')  process.exit(3);
      if (asked.dir === '<throw>') throw new Error('thread blew up');

      // Which thread answered, a little later, so that asks made together overlap.
      if (asked.dir === '<who>')
        return setTimeout(() => parentPort.postMessage({ id: asked.id, paths: [], packs: [], bytes: threadId }), 50);

      handler(asked);
    });

    require('./worker.js');
  `);
});

afterAll(async () => {
  await rm(dir,   { recursive: true, force: true });
  await rm(built, { recursive: true, force: true });
});

describe('the extraction pool', () => {
  it('answers on a thread what extraction answers on the main thread', async () => {
    const inputs: Wrapped[] = [
      { absolute: zipOf('one.zip', { 'a.csv': '1,2\n', 'b.csv': '3,4\n' }), container: 'zip' },
      { absolute: zipOf('two.zip', { 'a.csv': '5,6\n' }), container: 'zip', shape: 0 },
    ];

    const pool   = new Pool(2, join(built, 'worker.js'));
    const thread = await pool.extract(inputs, await fresh('thread'), [{ header: false }]);
    const main   = await extractInto(inputs, await fresh('main'), [{ header: false }]);

    expect(contents(thread.paths)).toEqual(contents(main.paths));
    expect(thread.packs.map(pack => pack && readFileSync(pack, 'utf8'))).toEqual(main.packs.map(pack => pack && readFileSync(pack, 'utf8')));
    expect(thread.bytes).toBe(main.bytes);
  });

  it('rejects with the error the extraction failed with', async () => {
    const pool = new Pool(1, join(built, 'worker.js'));

    await expect(pool.extract([{ absolute: join(dir, 'one.zip'), container: 'rar' }], await fresh('unknown')))
      .rejects.toThrow(/Unknown container 'rar'/);
  });

  it('replaces a thread that exits, and the extraction waiting behind it still runs', async () => {
    const pool   = new Pool(1, shim);
    const inputs = [{ absolute: zipOf('after-exit.zip', { 'a.csv': 'after' }), container: 'zip' }];

    const lost  = pool.extract(inputs, '<exit>');
    const after = pool.extract(inputs, await fresh('after-exit'));

    await expect(lost).rejects.toThrow('extraction thread exited (3)');
    expect(contents((await after).paths)).toEqual([[['0-0-a.csv', 'after']]]);
  });

  it('replaces a thread that throws, and keeps no more threads than it is given', async () => {
    const pool   = new Pool(1, shim);
    const inputs = [{ absolute: zipOf('after-throw.zip', { 'a.csv': 'after' }), container: 'zip' }];

    await expect(pool.extract(inputs, '<throw>')).rejects.toThrow('thread blew up');

    // The thread said so twice — its error and its exit — and is counted out once.
    await new Promise(resolve => setTimeout(resolve, 100));

    const after   = await pool.extract(inputs, await fresh('after-throw'));
    const threads = await Promise.all([1, 2, 3, 4].map(() => pool.extract([], '<who>')));

    expect(contents(after.paths)).toEqual([[['0-0-a.csv', 'after']]]);
    expect(new Set(threads.map(answer => answer.bytes)).size).toBe(1);
  });

  it('closed, stops its threads and fails what was under way, waiting, or asked after', async () => {
    const pool = new Pool(1, shim);

    const under   = expect(pool.extract([], '<who>')).rejects.toThrow(/extraction thread exited/);
    const waiting = expect(pool.extract([], '<who>')).rejects.toThrow('extraction pool closed');

    await pool.close();

    await under;
    await waiting;
    await expect(pool.extract([], '<who>')).rejects.toThrow('extraction pool closed');
  });
});
