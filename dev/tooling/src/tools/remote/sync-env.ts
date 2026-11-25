import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { confirm, input } from '../../shared/ui/prompts';
import { info, success, error, warn, section } from '../../shared/ui/logger';
import { parseRemoteDest } from './types';

const rootDir = path.resolve(__dirname, '../../../../..');

/** Directories never walked, besides every directory whose name starts with a dot. */
const EXCLUDE = new Set(['node_modules', 'dist']);

/** Quote a string as one word for a POSIX shell. */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Every `.env` file under `root`, as sorted absolute paths. Skips node_modules, dist and every
 * dot-directory (.git, .deprecated, ...), and does not follow symlinks. A directory it cannot read
 * is reported and skipped.
 */
function findEnvFiles(root: string = rootDir): string[] {
  const found: string[] = [];
  const pending = [root];

  while (pending.length > 0) {
    const dir = pending.pop()!;
    let entries: fs.Dirent[];

    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err: any) {
      warn(`Skipping ${path.relative(root, dir) || '.'}: ${err.message}`);
      continue;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (! entry.name.startsWith('.') && ! EXCLUDE.has(entry.name)) {
          pending.push(path.join(dir, entry.name));
        }
      } else if (entry.isFile() && entry.name === '.env') {
        found.push(path.join(dir, entry.name));
      }
    }
  }

  return found.sort();
}

// ── Test exports ──────────────────────────────────────────────────────────────

export const _test_findEnvFiles = findEnvFiles;

// ── Public ────────────────────────────────────────────────────────────────────

/**
 * Copy every .env file in the monorepo to a remote server, keeping its path relative to the
 * project root.
 *
 * The prompt takes `user@host:/remote/base/path` (see parseRemoteDest). After listing the files
 * it asks for confirmation, since each one overwrites the remote file of the same path. Each file
 * then goes to `<base>/<rel-path>/.env`: ssh creates the directory under umask 077, scp copies the
 * file, and ssh sets it to mode 600. A failed file does not stop the others; the summary names the
 * failures and the exit code is 1.
 */
export async function run(root: string = rootDir): Promise<void> {
  const raw = await input('Remote destination (user@host:/remote/path):');
  const dest = parseRemoteDest(raw);

  const files = findEnvFiles(root);

  if (files.length === 0) {
    warn('No .env files found in the project.');
    return;
  }

  const relativeOf = (file: string) => path.relative(root, file).split(path.sep).join('/');

  section(`Found ${files.length} .env file(s)`);

  for (const file of files) {
    info(relativeOf(file));
  }

  console.log();

  const proceed = await confirm(
    `Overwrite ${files.length} .env file(s) on ${dest.userHost} under ${dest.path}?`,
    false,
  );

  if (! proceed) {
    warn('Aborted.');
    return;
  }

  const failed: string[] = [];

  for (const file of files) {
    const relative = relativeOf(file);
    const remoteFile = `${dest.path}/${relative}`;
    const remoteDir = path.posix.dirname(remoteFile);

    try {
      execFileSync('ssh', ['--', dest.userHost, `umask 077 && mkdir -p -- ${shq(remoteDir)}`], { stdio: 'pipe' });
      // The scp target is not shell-quoted: scp transfers over SFTP, which takes the path as is.
      execFileSync('scp', ['-q', '--', file, `${dest.userHost}:${remoteFile}`], { stdio: 'pipe' });
      execFileSync('ssh', ['--', dest.userHost, `chmod 600 -- ${shq(remoteFile)}`], { stdio: 'pipe' });
      success(relative);
    } catch (err: any) {
      failed.push(relative);
      error(`${relative} — ${err.message}`);
    }
  }

  console.log();

  if (failed.length > 0) {
    error(`Synced ${files.length - failed.length} of ${files.length} file(s) to ${raw.trim()}; failed: ${failed.join(', ')}`);
    process.exitCode = 1;
    return;
  }

  success(`Done. ${files.length} file(s) synced to ${raw.trim()}.`);
}
