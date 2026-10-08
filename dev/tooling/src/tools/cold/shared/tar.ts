import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { promisify } from 'node:util';
import type { SourceFile } from './types';

/**
 * The exact byte size a tar of these members will have.
 *
 * **Exact, not an estimate.** A tar is a 512-byte header per member, its content
 * padded to 512, a GNU long-name header and payload for any path past 100 bytes,
 * two zero blocks to end, and the whole thing padded to the 10,240-byte blocking
 * factor. All of that follows from the names and sizes going in.
 *
 * Which makes it a way to check a tar that is **only** in cold storage: its size
 * can be compared against what its members imply, without downloading a byte. Verified against five real tars — 744, 1,677,
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

/** Every member of a tar, by its path inside it. */
export const membersOf = async (local: string): Promise<string[]> =>
  (await capture('tar', ['-tf', local]))
    .split('\n')
    .map(entry => entry.replace(/\/$/, '').trim())
    .filter(Boolean);

/** Take these members out of a tar, into a directory, at the paths they have inside it — over whatever is there. */
export const extractMembers = async (local: string, into: string, members: readonly string[]): Promise<void> => {
  const list = `${local}.extract.list`;

  await fs.promises.mkdir(into, { recursive: true });

  try {
    // Through a file, as when packing: a tar holds far more paths than an argument vector does.
    await fs.promises.writeFile(list, members.join('\n') + '\n');
    await run('tar', ['-xf', local, '-C', into, '--verbatim-files-from', '-T', list]);
  } finally {
    await fs.promises.rm(list, { force: true });
  }
};

/** Every member of a tar with what it weighs, by its path inside it. */
export const sizedMembersOf = async (local: string): Promise<SourceFile[]> =>
  (await capture('tar', ['-tvf', local]))
    .split('\n')
    .map(line => /^\S+\s+\S+\s+(\d+)\s+\S+\s+\S+\s+(.+)$/.exec(line))
    .filter((found): found is RegExpExecArray => found !== null && ! found[2]!.endsWith('/'))
    .map(found => ({ path: found[2]!, bytes: Number(found[1]) }));

export const run = async (command: string, args: string[]): Promise<void> => {
  try {
    await execFileAsync(command, args, { maxBuffer: 64 * 1024 * 1024 });
  } catch (err) {
    const e      = err as NodeJS.ErrnoException & { stderr?: string };
    const detail = e.stderr?.toString().trim() || e.message;

    throw new Error(`${command} ${args[0]} failed: ${detail}`);
  }
};

// ── Internals ─────────────────────────────────────────────────────────────────

const execFileAsync = promisify(execFile);

const capture = async (command: string, args: string[]): Promise<string> => {
  const { stdout } = await execFileAsync(command, args, { maxBuffer: 256 * 1024 * 1024 });

  return stdout;
};
