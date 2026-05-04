import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { input } from '../../shared/ui/prompts';
import { success, error, section, spacer } from '../../shared/ui/logger';
import { parseRemoteDest } from './types';
import type { RemoteDest } from './types';

// ── Public ────────────────────────────────────────────────────────────────────

/**
 * Pull files from a remote path via SSH+md5sum, skipping files whose
 * local checksum already matches the remote.
 */
export async function run(source?: string): Promise<void> {
  const rawSrc = source ?? await input('Remote source (user@host:/remote/path):');
  const src    = parseRemoteDest(rawSrc);

  if (! src) {
    error('Invalid source — expected format: user@host:/remote/path');
    process.exit(1);
  }

  const localBase = await input('Local destination path:', '/data/bitmex/remote');

  section(`Syncing ${rawSrc} → ${localBase}`);

  let remoteFiles: { checksum: string; remotePath: string }[];

  try {
    remoteFiles = listRemoteFiles(src);
  } catch (err: any) {
    error(`SSH listing failed — ${err.message}`);
    process.exit(1);
  }

  let pulled  = 0;
  let skipped = 0;

  for (const { checksum, remotePath } of remoteFiles) {
    const rel       = remotePath.slice(src.path.length);
    const localPath = path.join(localBase, rel);
    const localHash = localMd5(localPath);

    if (localHash === checksum) {
      skipped++;
      continue;
    }

    execSync(`scp "${src.userHost}:${remotePath}" "${localPath}"`);
    pulled++;
  }

  spacer();

  if (pulled === 0) {
    success('All files up to date.');
  } else {
    success(`Done. Pulled ${pulled} file(s), skipped ${skipped}.`);
  }
}

// ── Private ───────────────────────────────────────────────────────────────────

function localMd5(filePath: string): string | null {
  if (! fs.existsSync(filePath)) {
    return null;
  }

  return crypto.createHash('md5').update(fs.readFileSync(filePath)).digest('hex');
}

function listRemoteFiles(src: RemoteDest): { checksum: string; remotePath: string }[] {
  const out = String(execSync(`ssh "${src.userHost}" "find ${src.path} -type f | xargs md5sum"`));

  return out
    .split('\n')
    .filter(line => line.includes('  '))
    .map(line => {
      const idx = line.indexOf('  ');

      return {
        checksum:   line.slice(0, idx).trim(),
        remotePath: line.slice(idx + 2).trim(),
      };
    })
    .filter(({ checksum, remotePath }) => checksum.length > 0 && remotePath.length > 0);
}

// ── Test exports ──────────────────────────────────────────────────────────────

export const _test_localMd5        = localMd5;
export const _test_listRemoteFiles = listRemoteFiles;
