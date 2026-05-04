import { execSync } from 'node:child_process';
import path from 'node:path';
import { input } from '../../shared/ui/prompts';
import { info, success, error, warn, section } from '../../shared/ui/logger';
import { parseRemoteDest } from './types';

const rootDir = path.resolve(__dirname, '../../../../..');

const EXCLUDE = ['node_modules', 'dist', '.git'];

function findEnvFiles(): string[] {
  const result = execSync(
    `find "${rootDir}" ${EXCLUDE.map(d => `-not -path "*/${d}/*"`).join(' ')} -name ".env" -type f`,
    { encoding: 'utf-8' }
  );

  return result
    .trim()
    .split('\n')
    .filter(Boolean)
    .sort();
}

// ── Test exports ──────────────────────────────────────────────────────────────

export const _test_findEnvFiles = findEnvFiles;

// ── Public ────────────────────────────────────────────────────────────────────

/**
 * Sync all .env files in the monorepo to a remote server via scp,
 * preserving their directory structure relative to the project root.
 *
 * Prompt accepts: user@host:/remote/base/path
 * Each file is copied to: user@host:/remote/base/path/<rel-path>/.env
 */
export async function run(): Promise<void> {
  const raw = await input('Remote destination (user@host:/remote/path):');
  const dest = parseRemoteDest(raw);

  if (! dest) {
    error('Invalid destination — expected format: user@host:/remote/path');
    process.exit(1);
  }

  const files = findEnvFiles();

  if (files.length === 0) {
    warn('No .env files found in the project.');
    return;
  }

  section(`Found ${files.length} .env file(s)`);

  for (const file of files) {
    info(file.replace(rootDir + '/', ''));
  }

  console.log();

  for (const file of files) {
    const relative = file.replace(rootDir + '/', '');
    const remoteFile = `${dest.path}/${relative}`;
    const remoteDir = path.posix.dirname(remoteFile);

    try {
      execSync(`ssh "${dest.userHost}" "mkdir -p ${remoteDir}"`, { stdio: 'pipe' });
      execSync(`scp "${file}" "${dest.userHost}:${remoteFile}"`, { stdio: 'pipe' });
      success(relative);
    } catch (err: any) {
      error(`${relative} — ${err.message}`);
    }
  }

  console.log();
  info(`Done. ${files.length} file(s) synced to ${raw}.`);
}
