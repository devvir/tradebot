import path from 'node:path';
import { getEnv, parseEnvFile, requiredEnv } from '../../shared/utils/env';
import type { ColdConfig, Origin, Tar } from './types';

/** What a GB means everywhere here, including in what Mega reports. */
export const GB = 1024 ** 3;

/**
 * What a tar is filled to before another is started, in GB.
 *
 * **It is where a clean cut is looked for, never a limit.** A tar holds whole
 * partitions and nothing less, so one partition larger than this is a tar of
 * its own, whatever it weighs.
 *
 * Hardcoded rather than configured: it decides the shape of what lands in cold
 * storage, and a value that drifts between runs makes that shape inconsistent
 * for no benefit.
 */
export const CAPS: Record<Origin, number> = {
  vault:    5,
  archives: 5,
};

/** How long to wait before asking Mega again. */
export const POLL_MS = 30_000;

/**
 * Days after a month ends before the catalog takes its partitions as settled.
 * The catalog's own rule, repeated here for the one question only this side
 * asks: whether a month that is not in the catalog could have been settled by
 * now.
 */
export const SETTLE_DAYS = 15;

/** Between two askings of the catalog, in watch mode. */
export const WATCH_MS = 30 * 60_000;

/**
 * Resolve the configuration for one origin.
 *
 * **Every local path defaults to a place under `DATA_DIR`, and every one of them
 * can still be overridden.** The layout under the data root is a default, so a
 * host that moves its data to another partition changes one variable.
 *
 * Required:
 *   - `DATA_DIR`  — the data root that the rest hang off
 *   - `MEGA_ROOT` — where this project's trees live in Mega
 *
 * Optional:
 *   - `SOURCES_COLD_DIR`     — cold's own directory (`<DATA_DIR>/@cold`)
 *   - `ARCHIVES_DIR`         — the archives (`<DATA_DIR>/archives`)
 *   - `VAULT_DIR`            — the vault (`<DATA_DIR>/vault`)
 *   - `COLD_QUEUE_TARGET_GB` — GB still queued before packing pauses (10)
 *   - `COLD_SETTLED_HOURS`   — hours a settled partition must also have gone unchanged (none)
 *   - `CATALOG_URL`          — where the catalog answers from this host
 *   - `CATALOG_TOKEN`        — sent to it on every request
 */
export const loadConfig = (origin: Origin): ColdConfig => {
  const dataDir = requiredEnv('DATA_DIR');
  const under   = (name: string, fallback: string): string =>
    getEnv(name, '') || path.join(dataDir, fallback);

  /**
   * Everything one run holds lives together — the staging tars, the lock, and
   * the record of what is inside them — so the state is one directory to look
   * at, back up, or reason about.
   */
  const coldRoot = under('SOURCES_COLD_DIR', '@cold');
  const archives = catalogModule();

  return {
    sourceRoot:    under(SOURCES[origin].env, SOURCES[origin].under),
    vaultRoot:     under(SOURCES.vault.env, SOURCES.vault.under),
    coldRoot,
    megaRoot:      `${requiredEnv('MEGA_ROOT').replace(/\/$/, '')}/${REMOTE[origin]}`,
    dbPath:        path.join(coldRoot, 'cold.sqlite'),
    capBytes:      CAPS[origin] * GB,
    queueTargetGb: Number(getEnv('COLD_QUEUE_TARGET_GB', '') || QUEUE_TARGET_GB),
    settledHours:  getEnv('COLD_SETTLED_HOURS', '') ? Number(getEnv('COLD_SETTLED_HOURS', '')) : null,
    catalogUrl:    (getEnv('CATALOG_URL', '') || `http://localhost:${archives['CATALOG_PORT'] || 9010}`).replace(/\/$/, ''),
    catalogToken:  getEnv('CATALOG_TOKEN', '') || archives['CATALOG_TOKEN'] || '',
  };
};

/**
 * What a tar is called: `<venue>-<YYYYMM>.<NNN>.tar`.
 *
 * **The name says which venue-month it belongs to and nothing about what is
 * inside.** Which partitions a tar holds is the record's to say: partitions are
 * grouped by weight, and a month gains further tars as more of it is stored.
 */
export const tarName = (venue: string, month: string, seq: number): string =>
  `${venue}-${month}.${String(seq).padStart(3, '0')}.tar`;

/**
 * Where a tar lives, resolved now rather than recorded then.
 *
 * **The record stores the part of the path that is about the tar**, and nothing
 * about where this deployment keeps its trees: `bybit/2020/bybit-202003.001.tar`
 * remotely, `bybit/bybit-202003.001.tar` locally. The roots come from the
 * environment on every use, so moving to another Mega account or another disk
 * is an `.env` edit and the record does not change at all.
 */
export const remotePath = (config: ColdConfig, tar: Pick<Tar, 'remote'>): string =>
  `${config.megaRoot}/${tar.remote}`;

export const localPath = (config: ColdConfig, origin: Origin, tar: Pick<Tar, 'local'>): string =>
  path.join(config.coldRoot, origin, tar.local);

// ── Internals ─────────────────────────────────────────────────────────────────

/** GB still queued before packing pauses, when the environment says nothing. */
const QUEUE_TARGET_GB = 10;

/**
 * Which tree each origin backs up: the default location, and what may move it.
 *
 * **Named for the tree, and for nothing else** — not for the service that fills
 * it and not for the tool that reads it.
 */
const SOURCES: Record<Origin, { env: string; under: string }> = {
  vault:    { env: 'VAULT_DIR',    under: 'vault' },
  archives: { env: 'ARCHIVES_DIR', under: 'archives' },
};

/**
 * Where each origin sits in Mega, below `MEGA_ROOT`.
 *
 * **The vault is not a source.** `sources/` holds the trees data arrives in —
 * the venue archives, and the REST and websocket captures to come — each a
 * record of what somebody else published. The vault is the other end: the
 * normalised product, whatever it was made from.
 */
const REMOTE: Record<Origin, string> = {
  vault:    'vault',
  archives: 'sources/archives',
};

/**
 * The catalog's own settings, where this host runs it: its port and its token
 * are in the module that deploys it, and saying either a second time here
 * would be a second place for it to be wrong.
 */
const catalogModule = (): Record<string, string> =>
  parseEnvFile(path.resolve(__dirname, '../../../../../modules/collect/archives/.env'));
