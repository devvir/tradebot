import path from 'node:path';
import { getEnv, requiredEnv } from '../../shared/utils/env';
import type { ColdConfig, Origin } from './types';

/** What a GB means everywhere here, including in what Mega reports. */
export const GB = 1024 ** 3;

/**
 * Largest a tar may get before a new one is started, per origin.
 *
 * **A restore means a different thing in each tree, so the number does too.**
 *
 * The vault is queried by symbol, and a symbol is never split across two tars,
 * so its cap is what a *restore* costs — pulling one symbol back should not
 * mean downloading a venue-month of other people's data, and at two gigabytes a
 * decade of one symbol is a couple of hundred GB rather than a couple of TB.
 *
 * Archives are restored a venue-month at a time and are not read by anything
 * routinely, so there is no fine-grained restore to protect and a larger part
 * is simply fewer objects for Mega to carry.
 *
 * Hardcoded rather than configured: the cap decides the shape of what lands in
 * cold storage, and a value that drifts between runs makes the archive
 * inconsistent for no benefit.
 */
export const CAPS: Record<Origin, number> = {
  vault:    2,
  archives: 5,
};

/** How long to wait before asking the queue again. */
export const POLL_MS = 30_000;

/**
 * Gigabytes still queued before packing pauses, when the environment says
 * nothing.
 *
 * **Stated in the unit it is thought about in.** Nobody sizes an upload buffer
 * in bytes, so the number is carried as GB from the environment to the log line
 * and converted only where a comparison needs bytes. Storing bytes instead meant
 * a target set as `10000000000` printing back as `9.3GB`, which is the same
 * quantity and answers a question nobody asked.
 */
const QUEUE_TARGET_GB = 10;


/**
 * Resolve the configuration for one origin.
 *
 * **Every local path defaults to a place under `DATA_DIR`, and every one of them
 * can still be overridden.** The two are not in tension: the layout under the
 * data root is a default, so a host that moves its data to another partition
 * changes one variable. Writing the root into each path instead would not be a
 * default at all — it would be the same decision taken again per path, and
 * moving the root would mean finding all of them.
 *
 * Required:
 *   - `DATA_DIR`     — the data root that the rest hang off
 *   - `MEGA_ROOT`    — where this project's trees live in Mega, genuinely external
 *
 * Optional, each defaulting under `DATA_DIR`:
 *   - `SOURCES_COLD_DIR`        — cold's own directory (`@cold`)
 *   - `VAULT_DIR`               — the vault (`vault`)
 *   - `ARCHIVES_DIR`            — the raw venue archives (`archives`)
 *   - `COLD_QUEUE_TARGET_GB`
 */
export const loadConfig = (origin: Origin): ColdConfig => {
  const dataDir = requiredEnv('DATA_DIR');
  const under   = (name: string, fallback: string): string =>
    getEnv(name, '') || path.join(dataDir, fallback);

  /**
   * Everything one run holds lives together — the staging tars, the lock, and
   * the index that says what is inside them — so the state is one directory to
   * look at, back up, or reason about.
   */
  const coldRoot = under('SOURCES_COLD_DIR', '@cold');

  return {
    sourceRoot:  under(SOURCES[origin].env, SOURCES[origin].under),
    vaultRoot:   under(SOURCES.vault.env, SOURCES.vault.under),
    sharedRoot:  path.join(dataDir, '@shared'),
    coldRoot,
    megaRoot:    `${requiredEnv('MEGA_ROOT').replace(/\/$/, '')}/${REMOTE[origin]}`,
    dbPath:      path.join(coldRoot, 'cold.sqlite'),
    capBytes:    CAPS[origin] * GB,
    queueTargetGb: Number(getEnv('COLD_QUEUE_TARGET_GB', '') || QUEUE_TARGET_GB),
  };
};

/**
 * Where a part actually lives, resolved now rather than recorded then.
 *
 * **The database stores the part of the path that is about the part**, and
 * nothing about where this deployment keeps its trees: `bitget/2020/202010.p01.tar`
 * remotely, `bitget/202010.p01.tar` locally. The roots come from the environment
 * on every use, so moving to another Mega account, another disk, or another
 * machine entirely is an `.env` edit and the database does not change at all.
 *
 * Recording the absolute path instead made the environment a decision taken once
 * and then frozen: a Mega account move left 714 rows pointing at a tree that no
 * longer existed, and every one of them read as missing from cold storage. What
 * a variable is for is precisely that it can vary.
 */
export const remotePath = (config: ColdConfig, part: { remote: string }): string =>
  `${config.megaRoot}/${part.remote}`;

export const localPath = (config: ColdConfig, origin: Origin, part: { local: string }): string =>
  path.join(config.coldRoot, origin, part.local);

// ── Internals ─────────────────────────────────────────────────────────────────

/**
 * Which tree each origin backs up: the default location, and what may move it.
 *
 * **A default is a fact; a deployment's actual path is not.** These names are
 * what you get having set nothing, which is worth stating — where any given
 * installation actually keeps its trees is what the variables are for, and is
 * knowable only by reading them.
 *
 * **Named for the tree, and for nothing else.** Not for the service that fills
 * it and not for the tool that reads it: the vault is the vault whether or not
 * stocker is deployed here, and it is still the vault when something other than
 * `cold` wants it. Borrowing a service's variable looks like it keeps the two in
 * agreement and does the opposite — that name is set in the service's module
 * `.env`, which tooling reads only when asked for it by name, so the agreement
 * lasts exactly as long as nobody overrides the default. A host that backs up a
 * vault built elsewhere may not have that module checked out at all, and nobody
 * would think to edit an inactive module's configuration to make a backup run.
 */
const SOURCES: Record<Origin, { env: string; under: string }> = {
  vault:    { env: 'VAULT_DIR',    under: 'vault' },
  archives: { env: 'ARCHIVES_DIR', under: 'archives' },
};

/**
 * Where each origin sits in Mega, below `MEGA_ROOT`.
 *
 * **The vault is not a source.** `sources/` holds the trees data arrives in —
 * the venue archives now, the REST and websocket captures later — each one a
 * record of what somebody else published. The vault is the opposite end: the
 * normalised product consumers actually read, derived from those sources and
 * reproducible from them. Filing it under `sources/` said it was another input.
 *
 * Held here rather than as one environment variable per origin, for the same
 * reason the local paths are: the layout is a decision, and taking it once in
 * code beats taking it again in every deployment.
 */
const REMOTE: Record<Origin, string> = {
  vault:    'vault',
  archives: 'sources/archives',
};
