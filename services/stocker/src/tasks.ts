import { wrappedFor } from './build';
import { weightsOf } from './containers';
import type { DiskFile, Group, Task } from './types';

/** One group per catalog symbol, of its own files. The bundle `@` is one group like any other. */
export const groupsOf = (files: DiskFile[]): Group[] => {
  const bySymbol = new Map<string, DiskFile[]>();

  for (const one of files) bySymbol.set(one.file.symbol, [...bySymbol.get(one.file.symbol) ?? [], one]);

  return [...bySymbol].map(([symbol, inputs]) => ({ symbol, inputs }));
};

/**
 * One group per catalog symbol, of a neighbour's edge files — for the symbols
 * the month itself holds, where those are known by name. A neighbour's edge
 * belongs to a symbol this month also holds; a symbol that only appears in the
 * neighbour has nothing of this month to complete.
 */
export const sideGroupsOf = (donated: DiskFile[], symbols: ReadonlySet<string> | null): Group[] =>
  groupsOf(donated.filter(one => ! symbols || symbols.has(one.file.symbol)));

/**
 * The work a partition is split into: an instrument big enough to be read on
 * its own, or a batch of small ones read together (see `buildBatch`). A batch
 * closes at `BATCH_BYTES` of input or `BATCH_INSTRUMENTS` instruments, so one
 * read's temporary table stays bounded.
 */
export const tasksOf = (groups: Group[]): Task[] => {
  const tasks: Task[] = [];
  let batch: Group[]  = [];
  let bytes           = 0;

  for (const group of groups) {
    const size = bytesOf(group);

    if (size >= directBytes) {
      tasks.push([group]);

      continue;
    }

    batch.push(group);
    bytes += size;

    if (bytes >= BATCH_BYTES || batch.length >= BATCH_INSTRUMENTS) {
      tasks.push(batch);
      batch = [];
      bytes = 0;
    }
  }

  if (batch.length) tasks.push(batch);

  return tasks;
};

/**
 * The same tasks, with a big instrument whose archives inflate to more than
 * `PIECE_BYTES` made several: a piece each, of as many of its files as inflate
 * to that much, or of one file that outweighs it alone. Scratch then holds a
 * piece of it at a time and never the whole — see `joinPieces`.
 */
export const piecedOf = async (tasks: Task[]): Promise<Task[]> => {
  const pieced: Task[] = [];

  for (const task of tasks) {
    const group = task[0]!;

    if (! direct(task) || group.inputs.length === 1) {
      pieced.push(task);

      continue;
    }

    const weights = await weightsOf(wrapOf(task).inputs);
    const pieces: DiskFile[][] = [[]];

    let held = 0;

    group.inputs.forEach((input, at) => {
      if (held > 0 && held + weights[at]! > pieceBytes) {
        pieces.push([]);
        held = 0;
      }

      pieces.at(-1)!.push(input);
      held += weights[at]!;
    });

    if (pieces.length === 1) pieced.push(task);
    else {
      const of = pieced.length;

      pieces.forEach((inputs, at) => pieced.push([{ symbol: group.symbol, inputs, piece: { of, at } }]));
    }
  }

  return pieced;
};

export const bytesOf = (group: Group): number => group.inputs.reduce((total, one) => total + one.size, 0);

/** Whether a task is one big instrument — or a piece of one — read on its own straight into its file, and not a batch. */
export const direct = (task: Task): boolean => task.length === 1 && (!! task[0]!.piece || bytesOf(task[0]!) >= directBytes);

/** A task's archives as extraction is asked for them: a batch's small files gathered, a big instrument's as they are. */
export const wrapOf = (task: Task): ReturnType<typeof wrappedFor> => wrappedFor(task, ! direct(task));

// ── Internals ─────────────────────────────────────────────────────────────────

/**
 * An instrument this big (compressed input) is read on its own; anything
 * smaller joins a batch. A month of a busy symbol's trades is well above it, a
 * month of anything's candles well below.
 */
const DIRECT_BYTES = 32 * 1024 ** 2;

let directBytes = DIRECT_BYTES;

/** What a piece of a big instrument's archives inflates to, at most — unless one file is more. */
const PIECE_BYTES = 8 * 1024 ** 3;

let pieceBytes = PIECE_BYTES;

/** Where a batch closes: input bytes, or instruments. */
const BATCH_BYTES       = 64 * 1024 ** 2;
const BATCH_INSTRUMENTS = 256;

// ── Test access ───────────────────────────────────────────────────────────────

/** Build in pieces as if a piece held this much, or what it really does again. */
export const _test_pieceAt = (bytes: number | null): void => { pieceBytes = bytes ?? PIECE_BYTES; };

/** Read an instrument on its own from this weight, or from the real one again. */
export const _test_directAt = (bytes: number | null): void => { directBytes = bytes ?? DIRECT_BYTES; };
