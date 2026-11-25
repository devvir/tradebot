import fs from 'node:fs';
import path from 'node:path';
import { membersOf, run } from '../../shared/tar';

/**
 * Write one tar of whole partitions, and prove it before letting anything else
 * see it.
 *
 * **Three names, one per step, so a run stopped anywhere picks up where it
 * was.** A tar is written to `.tar.tmp`, renamed to `.tar.unverified` once it is
 * written in full, compared against the source tree, and only then renamed to
 * `.tar`. Each rename is the record that the step before it finished:
 *
 * - a `.tmp` was being written, and is worth nothing — it is cleared at startup
 * - an `.unverified` is complete and unproven: it is not written again, and it
 *   is never uploaded, since nothing uploads anything but a `.tar`
 * - a `.tar` has been proven
 *
 * **An `.unverified` is only kept if it is this plan's.** Tar names are
 * deterministic and a plan is redrawn on every run, so the one found may have
 * been written for other partitions; it is listed first, and written again
 * where it does not hold exactly these members.
 *
 * **Verification compares contents, not presence.** A member count proves only
 * that the tar is not empty, while `tar -d` catches a truncated or altered
 * file — which matters because this becomes the only copy once the partition is
 * evicted locally. One that fails it is removed, since it is wrong.
 *
 * `verifying` is called when the comparison starts, which on a tar of millions
 * of members is as long a wait as the writing was.
 */
export const writePart = async (
  sourceRoot: string,
  local:      string,
  members:    string[],
  verifying?: () => void,
): Promise<void> => {
  const temporary = `${local}.tmp`;
  const written   = `${local}${UNVERIFIED}`;
  const list      = `${local}.list`;

  await fs.promises.mkdir(path.dirname(local), { recursive: true });

  if (fs.existsSync(written) && ! await holds(written, members))
    await fs.promises.rm(written, { force: true });

  try {
    if (! fs.existsSync(written)) {
      // The member list goes through a file rather than the argument vector: a tar
      // can hold tens of thousands of paths, far past any exec limit.
      await fs.promises.writeFile(list, members.join('\n') + '\n');

      await run('tar', ['-cf', temporary, '-C', sourceRoot, '--verbatim-files-from', '-T', list]);

      await fs.promises.rename(temporary, written);
    }

    verifying?.();

    try {
      await run('tar', ['-df', written, '-C', sourceRoot]);
    } catch (err) {
      await fs.promises.rm(written, { force: true });

      throw err;
    }

    await fs.promises.rename(written, local);
  } finally {
    await fs.promises.rm(list, { force: true });
    await fs.promises.rm(temporary, { force: true });
  }
};

/**
 * Clear the debris an interrupted run leaves behind.
 *
 * A `.tar.tmp` is by definition unfinished — it existed because a rename had
 * not happened — so there is nothing to weigh up. The `.list` files go with
 * them.
 */
export const clearTemporary = async (root: string): Promise<number> => {
  let removed = 0;

  const sweep = async (dir: string): Promise<void> => {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => []);

    for (const entry of entries) {
      const full = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        await sweep(full);

        continue;
      }

      if (entry.name.endsWith('.tar.tmp') || entry.name.endsWith('.tar.list')) {
        await fs.promises.rm(full, { force: true });

        removed++;
      }
    }
  };

  await sweep(root);

  return removed;
};

// ── Internals ─────────────────────────────────────────────────────────────────

/** Whether a tar lists exactly these members; false where it cannot be read. */
const holds = async (local: string, members: readonly string[]): Promise<boolean> => {
  try {
    const listed = new Set(await membersOf(local));

    return listed.size === members.length && members.every(member => listed.has(member));
  } catch {
    return false;
  }
};

/** What a tar is called once it is written in full and before it is proven. */
const UNVERIFIED = '.unverified';
