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

/** Free space, in GB, below which no further tar of the archives is asked back from cold storage. */
export const ARCHIVES_RESERVE_GB = 25;

/** Free space, in GB, left on the vault's volume after every vault file asked back is there, at the least. */
export const VAULT_RESERVE_GB = 5;

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
 *   - `DATA_ARCHIVES_DIR`         — the archives (`<DATA_DIR>/archives`)
 *   - `DATA_VAULT_DIR`            — the vault (`<DATA_DIR>/vault`)
 *   - `COLD_QUEUE_TARGET_GB` — GB still queued before packing pauses (10)
 *   - `COLD_SETTLED_HOURS`   — hours a settled partition must also have gone unchanged (none)
 *   - `CATALOG_DIR`          — where the catalog's database is (the archives module's, else `<DATA_DIR>/catalog`)
 *   - `CATALOG_DB`           — the database itself, where it is not `catalog.db` in there
 *   - `CATALOG_URL`          — where the catalog answers from this host (`http://localhost:<CATALOG_PORT>`)
 *   - `CATALOG_TOKEN`        — sent to it on every request (the archives module's)
 *
 * **What the environment leaves unset of the catalog's settings is read from
 * the archives module** (`modules/collect/archives/.env`, or `archivesEnv`),
 * whether or not `-m` names it. Its `CATALOG_DIR` has `${NAME}` references
 * expanded against the environment; its `CATALOG_PORT` and `CATALOG_TOKEN` are
 * taken as written. Where the module does not set `CATALOG_PORT`, the URL is
 * `http://localhost:9010`. Where it sets it empty (the catalog is then on a
 * host port docker picks) or to anything but a port, the URL is not known:
 * `catalogUnknown` says why, and is the error asking the catalog gives.
 */
export const loadConfig = (origin: Origin, archivesEnv: string = ARCHIVES_ENV): ColdConfig => {
  const dataDir = requiredEnv('DATA_DIR');
  const under   = (name: string, fallback: string): string =>
    getEnv(name, '') || path.join(dataDir, fallback);

  /**
   * Everything one run holds lives together — the staging tars, the lock, and
   * the record of what is inside them — so the state is one directory to look
   * at, back up, or reason about.
   */
  const coldRoot = under('SOURCES_COLD_DIR', '@cold');
  const archives  = parseEnvFile(archivesEnv);
  const catalog   = catalogUrl(archives, archivesEnv);
  const moduleDir = archives['CATALOG_DIR']?.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => getEnv(name, '')!);

  return {
    sourceRoot:    under(SOURCES[origin].env, SOURCES[origin].under),
    vaultRoot:     under(SOURCES.vault.env, SOURCES.vault.under),
    coldRoot,
    megaRoot:      `${requiredEnv('MEGA_ROOT').replace(/\/$/, '')}/${REMOTE[origin]}`,
    backupRoot:    `${requiredEnv('MEGA_ROOT').replace(/\/$/, '')}/@cold`,
    catalogDb:     getEnv('CATALOG_DB', '') || path.join(getEnv('CATALOG_DIR', '') || moduleDir || path.join(dataDir, 'catalog'), 'catalog.db'),
    catalogRoot:   `${requiredEnv('MEGA_ROOT').replace(/\/$/, '')}/@cold/catalog`,
    dbPath:        path.join(coldRoot, 'cold.sqlite'),
    capBytes:      CAPS[origin] * GB,
    queueTargetGb: Number(getEnv('COLD_QUEUE_TARGET_GB', '') || QUEUE_TARGET_GB),
    settledHours:  getEnv('COLD_SETTLED_HOURS', '') ? Number(getEnv('COLD_SETTLED_HOURS', '')) : null,
    ...catalog,
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
  vault:    { env: 'DATA_VAULT_DIR',    under: 'vault' },
  archives: { env: 'DATA_ARCHIVES_DIR', under: 'archives' },
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
 * The catalog's own settings, where this host runs it: its directory, its port
 * and its token are in the module that deploys it, and saying any of them a
 * second time here would be a second place for it to be wrong.
 */
const ARCHIVES_ENV = path.resolve(__dirname, '../../../../../modules/collect/archives/.env');

/** Where the catalog answers from this host: `CATALOG_URL`, else the archives module's `CATALOG_PORT` on localhost. */
const catalogUrl = (
  archives: Record<string, string>,
  file:     string,
): Pick<ColdConfig, 'catalogUrl' | 'catalogUnknown'> => {
  const url = getEnv('CATALOG_URL', '');

  if (url) return { catalogUrl: url.replace(/\/$/, ''), catalogUnknown: null };

  const port = archives['CATALOG_PORT'];

  if (port === undefined) return { catalogUrl: `http://localhost:${DEFAULT_CATALOG_PORT}`, catalogUnknown: null };

  if (/^\d+$/.test(port) && Number(port) >= 1 && Number(port) <= 65535) return { catalogUrl: `http://localhost:${port}`, catalogUnknown: null };

  const why = port === ''
    ? `CATALOG_PORT is empty in ${file}, so the catalog is on a host port docker picks`
    : `CATALOG_PORT in ${file} is not a port: ${port}`;

  return { catalogUrl: '', catalogUnknown: `${why} — set CATALOG_PORT there to the catalog's host port, or set CATALOG_URL` };
};

/** The catalog's host port where the archives module does not set `CATALOG_PORT`. */
const DEFAULT_CATALOG_PORT = 9010;
