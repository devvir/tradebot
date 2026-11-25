import { mkdir, readFile, readdir, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DuckDBConnection } from '@duckdb/node-api';
import { q } from '../db';
import { syncDir, syncFile } from '../durable';
import { STAGED } from '../vault';
import { PARQUET, nextSequence, orderOf, settleFile } from './shared';
import type { DiskFile, Group, VaultKey } from '../types';

/** Under a staging directory: what is built a piece at a time, until it is joined. */
export const PIECES = '.pieces';

/** In a piece's directory: the note that it is built. */
const FINISHED = '.built';

/** Where a piece of a symbol is built, under the staging directory of what it is part of. */
export const pieceDirOf = (dir: string, piece: NonNullable<Group['piece']>): string =>
  join(dir, PIECES, String(piece.of), String(piece.at));

/**
 * Join what was built a piece at a time into the files it would have been
 * built as whole: each instrument's rows, from every piece that has any, in
 * one file in `staging`.
 *
 * **A symbol whose archives inflate to more than scratch should hold at once is
 * built from a few of them at a time** — each piece extracted, written and
 * removed before the next — into `PIECES` under the staging directory, a
 * directory a symbol and a directory a piece within it. A piece is in time
 * order and the pieces need not follow one another, so this join sorts.
 *
 * The pieces are left where they are: they go with the staging directory once
 * the partition is in the vault, and until then a build that stops is taken up
 * from them — see `finishPiece`.
 *
 * `repeats` says whether a symbol's files repeat whole rows: a row repeated
 * across two pieces is then written once, as it is within one.
 */
export const joinPieces = async (
  conn:    DuckDBConnection,
  key:     VaultKey,
  staging: string,
  repeats: (of: string) => boolean,
): Promise<void> => {
  const root = join(staging, PIECES);

  for (const of of await readdir(root).catch(() => [] as string[])) {
    const parts = new Map<string, string[]>();

    for (const piece of await readdir(join(root, of)))
      for (const name of await readdir(join(root, of, piece)))
        if (name.endsWith(STAGED)) parts.set(name, [...parts.get(name) ?? [], join(root, of, piece, name)]);

    for (const [name, paths] of parts) {
      const out  = join(staging, name);
      const temp = `${out}.${nextSequence()}.tmp`;

      await conn.run(
        `COPY (SELECT ${repeats(of) ? 'DISTINCT ' : ''}* FROM read_parquet([${paths.map(q).join(', ')}]) ORDER BY ${orderOf(key)})
         TO ${q(temp)} ${PARQUET}`,
      );

      await settleFile(conn, temp, out, key, name.slice(0, -STAGED.length));
    }
  }
};

/**
 * Say that a piece is built: what it was built from, and what came of it.
 *
 * **A partition built a piece at a time takes hours, and a piece that is built
 * is not built again.** Each leaves a note beside its files as it finishes, and
 * a build that starts over — the service restarted, a piece failed — skips the
 * pieces whose note names the very files it would build them from. A piece
 * that was stopped half way has no note, and is built again from nothing.
 *
 * The staging directory is named for the partition's revision, so pieces built
 * from other archives, or under versions that write otherwise, are never found.
 * What the note adds is which files the piece held: how a symbol's files are
 * cut into pieces is not part of the revision.
 *
 * **The note is on the disk only after the piece's files are**, and is whole
 * or not there — written beside its name and renamed to it — so a note is never
 * found for files a power cut took back. See `durable`.
 */
export const finishPiece = async (dir: string, inputs: readonly DiskFile[], done: { rows: number; files: number }): Promise<void> => {
  await mkdir(dir, { recursive: true });

  for (const name of await readdir(dir))
    if (name.endsWith(STAGED)) await syncFile(join(dir, name));

  await syncDir(dir);

  const note = join(dir, FINISHED);
  const temp = `${note}.tmp`;

  await writeFile(temp, JSON.stringify({ inputs: inputs.map(input => input.file.key), ...done }));
  await syncFile(temp);
  await rename(temp, note);
  await syncDir(dir);
};

/** What came of a piece built before from these very files, or null where it is still to build. */
export const finishedPiece = async (dir: string, inputs: readonly DiskFile[]): Promise<{ rows: number; files: number } | null> => {
  try {
    const note = JSON.parse(await readFile(join(dir, FINISHED), 'utf8')) as { inputs: string[]; rows: number; files: number };

    return note.inputs.join('\n') === inputs.map(input => input.file.key).join('\n') ? { rows: note.rows, files: note.files } : null;
  } catch {
    return null;
  }
};

/**
 * Clear a staging directory of everything but the pieces that are built, and
 * the directory itself where that leaves nothing in it.
 */
export const keepPieces = async (staging: string): Promise<void> => {
  for (const pass of await readdir(staging).catch(() => [] as string[])) {
    const pieces = join(staging, pass, PIECES);

    for (const name of await readdir(join(staging, pass)).catch(() => [] as string[]))
      if (name !== PIECES) await rm(join(staging, pass, name), { recursive: true, force: true });

    for (const of of await readdir(pieces).catch(() => [] as string[])) {
      for (const at of await readdir(join(pieces, of)).catch(() => [] as string[])) {
        const built = await readFile(join(pieces, of, at, FINISHED)).then(() => true, () => false);

        if (! built) await rm(join(pieces, of, at), { recursive: true, force: true });
      }

      await rmdir(join(pieces, of)).catch(() => {});
    }

    await rmdir(pieces).catch(() => {});
    await rmdir(join(staging, pass)).catch(() => {});
  }

  await rmdir(staging).catch(() => {});
};
