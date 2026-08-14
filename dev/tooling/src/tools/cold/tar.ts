import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Write one part, and prove it before letting anything else see it.
 *
 * Built to `.tar.tmp` and renamed only once `tar -d` reports no difference
 * against the source tree. An interrupted run therefore leaves a `.tmp` that is
 * never mistaken for a finished tar and never uploaded.
 *
 * **Verification compares contents, not presence.** A member count proves only
 * that the tar is not empty, while `tar -d` catches a truncated or altered
 * file — which matters because this becomes the only copy once the partition is
 * evicted locally.
 */
export const writePart = async (
  sourceRoot: string,
  local:      string,
  members:    string[],
): Promise<void> => {
  const temporary = `${local}.tmp`;
  const list      = `${local}.list`;

  await fs.promises.mkdir(path.dirname(local), { recursive: true });

  // The member list goes through a file rather than the argument vector: a part
  // can hold tens of thousands of paths, far past any exec limit.
  await fs.promises.writeFile(list, members.join('\n') + '\n');

  try {
    await run('tar', ['-cf', temporary, '-C', sourceRoot, '-T', list]);
    await run('tar', ['-df', temporary, '-C', sourceRoot]);

    await fs.promises.rename(temporary, local);
  } finally {
    await fs.promises.rm(list, { force: true });
    await fs.promises.rm(temporary, { force: true });
  }
};

/**
 * Whether a tar left by an earlier run still holds exactly what its plan says.
 *
 * Run on resume, when a tar exists but Mega does not have it. Uploading is what
 * costs hours here, so a tar that survives this is reused rather than rebuilt.
 *
 * **Two questions, and `tar -d` only answers one.** It compares what is *in* the
 * tar against the tree, so it catches a member deleted, moved or rewritten since
 * packing. It says nothing about a member the plan lists and the tar never
 * had — that file is simply not examined, the diff passes, and the part uploads
 * while the database records a file that is not inside it. Nothing later
 * notices: the path is in `member`, so no future run considers it unpacked.
 *
 * That is reachable rather than theoretical. Part names are deterministic, so a
 * tar left by an earlier run is adopted by whichever plan lands on its name —
 * and a venue-month that has gained a partition since produces a plan wider than
 * the tar sitting there.
 */
export const verifyPart = async (
  sourceRoot: string,
  local:      string,
  members:    string[],
): Promise<boolean> => {
  try {
    const listed = new Set(
      (await capture('tar', ['-tf', local]))
        .split('\n')
        .map(entry => entry.replace(/\/$/, '').trim())
        .filter(Boolean),
    );

    if (listed.size !== members.length) return false;
    if (members.some(member => ! listed.has(member))) return false;

    await run('tar', ['-df', local, '-C', sourceRoot]);

    return true;
  } catch {
    return false;
  }
};

/**
 * The exact byte size a tar of these members will have.
 *
 * **Exact, not an estimate.** A tar is a 512-byte header per member, its content
 * padded to 512, a GNU long-name header and payload for any path past 100 bytes,
 * two zero blocks to end, and the whole thing padded to the 10,240-byte blocking
 * factor. All of that follows from the names and sizes going in.
 *
 * Which makes it a way to check a tar that is **only** in cold storage: its size
 * in Mega's listing can be compared against what its `member` rows imply,
 * without downloading a byte. Verified against five real tars — 744, 1,677,
 * 9,883, 405,422 and 12 members — every one predicted to the byte.
 */
export const tarSize = (members: { path: string; bytes: number }[]): number => {
  const pad = (value: number, to: number): number => Math.ceil(value / to) * to;

  let size = 0;

  for (const member of members) {
    const length = Buffer.byteLength(member.path);

    if (length > 100) size += 512 + pad(length + 1, 512);

    size += 512 + pad(member.bytes, 512);
  }

  return pad(size + 1024, 10240);
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

const capture = async (command: string, args: string[]): Promise<string> => {
  const { stdout } = await execFileAsync(command, args, { maxBuffer: 256 * 1024 * 1024 });

  return stdout;
};

const run = async (command: string, args: string[]): Promise<void> => {
  try {
    await execFileAsync(command, args, { maxBuffer: 64 * 1024 * 1024 });
  } catch (err) {
    const e      = err as NodeJS.ErrnoException & { stderr?: string };
    const detail = e.stderr?.toString().trim() || e.message;

    throw new Error(`${command} ${args[0]} failed: ${detail}`);
  }
};
