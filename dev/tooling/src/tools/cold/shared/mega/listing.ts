import { megaCmd, notThere } from './exec';

/**
 * Remove one object.
 *
 * Only ever called on an orphan a replan left behind, after its replacements are
 * confirmed in Mega and a person has said yes. `-f` suppresses the confirmation
 * mega-cmd would otherwise ask for on its own terms, not the one that matters.
 */
export const remove = async (remotePath: string): Promise<void> => {
  await megaCmd('mega-rm', ['-f', remotePath], { timeout: 120_000 });
};

/** Remove a directory and everything in it. Nothing, where it is not there. */
export const removeTree = async (remotePath: string): Promise<void> => {
  try {
    await megaCmd('mega-rm', ['-rf', remotePath], { timeout: 600_000 });
  } catch (err) {
    if (! notThere(err)) throw err;
  }
};

/**
 * Every object under a path, in one call.
 *
 * **Hundreds of parts, one round trip.** Asking per part is correct and costs a
 * process spawn each; a recursive listing answers the same question for a whole
 * origin at once, which is what makes it affordable to check *before* acting
 * rather than only when something already looks wrong.
 *
 * `-R` prints a `<directory>:` header and then its entries, so the current
 * directory is tracked as the output is read and each name joined to it.
 *
 * **Keyed relative to `root`**, which is what makes it comparable to the paths
 * the database holds. Those record a part's own location and not this
 * deployment's remote root, so keying the listing absolutely would mean pasting
 * the root onto every part at every lookup, in a dozen places, to undo a
 * difference neither side cares about.
 */
export const listing = async (
  root: string,
): Promise<Map<string, { bytes: number; handle: string | null }>> => {
  const found = new Map<string, { bytes: number; handle: string | null }>();

  try {
    const { stdout } = await megaCmd(
      'mega-ls', ['-lR', '--show-handles', root],
      { timeout: 300_000, maxBuffer: 256 * 1024 * 1024 });

    let dir = root.replace(/\/$/, '');

    for (const line of stdout.split('\n')) {
      const header = /^(\/?[^\s].*):$/.exec(line.trimEnd());

      if (header) {
        // Headers may come without the leading slash; anchor them to the root.
        const at = header[1]!;

        dir = at.startsWith('/') ? at : `/${at}`;

        continue;
      }

      const fields = line.trimEnd().split(/\s+/);
      const name   = fields[fields.length - 1];

      if (! name || line.startsWith('FLAGS') || line.startsWith('d')) continue;

      const size   = /^\S+\s+\d+\s+(\d+)\s/.exec(line);
      const handle = /\s(H:\S+)\s/.exec(line);

      if (size) found.set(relativeTo(`${dir}/${name}`, root), { bytes: Number(size[1]), handle: handle?.[1] ?? null });
    }
  } catch (err) {
    // A tree that is not there holds nothing. Anything else is not an answer, and is not taken for one.
    if (! notThere(err)) throw err;
  }

  return found;
};

/**
 * The size and handle Mega holds for a file, or null when it holds none.
 *
 * Mega publishes a file only once it is complete, so presence at the right size
 * *is* the proof an upload finished — there is no partial state to guard
 * against and nothing to re-download and compare.
 *
 * The handle is recorded because it identifies the stored object independently
 * of its path: a later check can prove the database and Mega still agree on
 * *which* file this is, which a size alone cannot.
 */
export const remote = async (
  remotePath: string,
): Promise<{ bytes: number; handle: string | null } | null> => {
  try {
    const { stdout } = await megaCmd(
      'mega-ls', ['-l', '--show-handles', remotePath], { timeout: 60_000 });

    return parseListing(stdout, remotePath.slice(remotePath.lastIndexOf('/') + 1));
  } catch (err) {
    // Not there is an answer. Anything else is not, and is not taken for one.
    if (! notThere(err)) throw err;

    return null;
  }
};

// ── Internals ─────────────────────────────────────────────────────────────────

/** Drop the root the listing was taken of; anything outside it keeps its path. */
const relativeTo = (full: string, root: string): string => {
  const base = root.replace(/\/$/, '');

  return full.startsWith(`${base}/`) ? full.slice(base.length + 1) : full;
};

/**
 * `----    1   4780000000 05Aug2026 22:09:10 H:7BtQjCAL 202405.p01.tar`
 *
 * Columns are `FLAGS VERS SIZE DATE TIME HANDLE NAME`, so the size is the
 * *second* number and not the first — `VERS` sits in front of it and is also
 * digits. The name is compared as a whole field rather than as a suffix, since
 * `x202405.p01.tar` ends with `202405.p01.tar`.
 */
const parseListing = (
  stdout: string,
  name:   string,
): { bytes: number; handle: string | null } | null => {
  for (const line of stdout.split('\n')) {
    const fields = line.trimEnd().split(/\s+/);

    if (fields[fields.length - 1] !== name) continue;

    const size   = /^\S+\s+\d+\s+(\d+)\s/.exec(line);
    const handle = /\s(H:\S+)\s/.exec(line);

    if (size) return { bytes: Number(size[1]), handle: handle?.[1] ?? null };
  }

  return null;
};

// ── Test access ───────────────────────────────────────────────────────────────

export const _test_parseListing = parseListing;
