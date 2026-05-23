import fs from 'node:fs';
import path from 'node:path';
import { listMegaDirSized, posixJoin } from './mega';
import type { SyncState } from '../types';

// Only canonical archive filenames are considered. Anything else (rogue files,
// `.tmp` markers, junk) is silently excluded — it shouldn't be uploaded,
// restored, or otherwise treated as an archive.
const ARCHIVE_RE = /^(all|\d{4}|\d{6}|\d{8})\.archive\.gz$/;

// ── Exports ──────────────────────────────────────────────────────────────────

/**
 * Build per-file sync states across local FS and Mega for the given
 * collections. One mega-ls per collection (parallel) and one local readdir
 * per collection (sequential, cheap).
 *
 *   - `outDir = null`   → skip the local scan; every state will have `local: null`
 *   - `megaBase = null` → skip Mega; every state will have `mega: null`
 *
 * Files are matched by exact name. Anything not matching the canonical
 * `(all|YYYY|YYYYMM|YYYYMMDD).archive.gz` pattern is excluded — including
 * `.tmp` files (forensic markers of crashed dumps), which never sort as
 * "real" archives by name and never need to be uploaded/restored.
 *
 * Output is sorted by (collection, file) for deterministic display.
 */
export async function syncStatesForCollections(
  collections: string[],
  outDir:      string | null,
  megaBase:    string | null,
): Promise<SyncState[]> {
  const localByColl = new Map<string, Map<string, number>>();
  const megaByColl  = new Map<string, Map<string, number>>();

  if (outDir) {
    for (const coll of collections) {
      localByColl.set(coll, scanLocalArchivesSized(outDir, coll));
    }
  }

  if (megaBase) {
    await Promise.all(collections.map(async coll => {
      megaByColl.set(coll, await listMegaDirSized(posixJoin(megaBase, coll)));
    }));
  }

  const states: SyncState[] = [];

  for (const coll of collections) {
    const local = localByColl.get(coll) ?? new Map<string, number>();
    const mega  = megaByColl.get(coll)  ?? new Map<string, number>();
    const files = new Set<string>([...local.keys(), ...mega.keys()]);

    for (const file of files) {
      if (! ARCHIVE_RE.test(file)) continue;  // exclude `.tmp` and rogue names

      const localSize = local.get(file);
      const megaSize  = mega.get(file);

      states.push({
        collection: coll,
        file,
        local: outDir && localSize !== undefined
          ? { path: path.join(outDir, coll, file), size: localSize }
          : null,
        mega: megaBase && megaSize !== undefined
          ? { path: posixJoin(megaBase, coll, file), size: megaSize }
          : null,
      });
    }
  }

  return states.sort((a, b) => {
    if (a.collection !== b.collection) return a.collection.localeCompare(b.collection);

    return a.file.localeCompare(b.file);
  });
}

/**
 * List subdirectories under `outDir` (one per collection). Returns an empty
 * list if `outDir` doesn't exist. Helper for callers that want "all
 * collections with at least something on local".
 */
export function listLocalCollections(outDir: string): string[] {
  if (! fs.existsSync(outDir)) return [];

  return fs.readdirSync(outDir, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name)
    .sort();
}

// ── Internals ────────────────────────────────────────────────────────────────

function scanLocalArchivesSized(outDir: string, collection: string): Map<string, number> {
  const dir    = path.join(outDir, collection);
  const result = new Map<string, number>();

  if (! fs.existsSync(dir)) return result;

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (! entry.isFile())               continue;
    if (! ARCHIVE_RE.test(entry.name))  continue;

    result.set(entry.name, fs.statSync(path.join(dir, entry.name)).size);
  }

  return result;
}
