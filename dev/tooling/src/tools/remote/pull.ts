import { execSync } from 'node:child_process';
import { input } from '../../shared/ui/prompts.js';
import { success, error, section, spacer } from '../../shared/ui/logger.js';
import { parseRemoteDest } from './types.js';

// ── Public ────────────────────────────────────────────────────────────────────

/**
 * Pull files from a remote path using rsync.
 * Skips unchanged files by comparing size and mtime (--times preserves mtime on transfer).
 */
export async function run(source?: string): Promise<void> {
  const rawSrc = source ?? await input('Remote source (user@host:/remote/path):');
  const src = parseRemoteDest(rawSrc);

  if (! src) {
    error('Invalid source — expected format: user@host:/remote/path');
    process.exit(1);
  }

  const localBase = await input('Local destination path:', '/data/bitmex/remote');

  // Trailing slash on src.path means rsync copies the contents, not the directory itself
  const remotePath = `${src.userHost}:${src.path}/`;

  section(`Syncing ${rawSrc} → ${localBase}`);

  try {
    execSync(
      `rsync -av --times "${remotePath}" "${localBase}/"`,
      { stdio: 'inherit' }
    );
  } catch (err: any) {
    error(`rsync failed — ${err.message}`);
    process.exit(1);
  }

  spacer();
  success('Done.');
}
