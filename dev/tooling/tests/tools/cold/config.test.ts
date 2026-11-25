import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../../src/tools/cold/config';
import { venues } from '../../../src/tools/cold/shared/catalog';

/** Where the catalog is, from the environment first and the archives module's .env after. */

let dir: string;
let moduleEnv: string;

beforeEach(() => {
  dir       = fs.mkdtempSync(path.join(os.tmpdir(), 'cold-config-'));
  moduleEnv = path.join(dir, 'archives.env');

  vi.stubEnv('DATA_DIR', '/data');
  vi.stubEnv('MEGA_ROOT', '/mega');

  for (const name of ['CATALOG_DIR', 'CATALOG_DB', 'CATALOG_URL', 'CATALOG_TOKEN']) vi.stubEnv(name, '');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** The archives module's .env, as these lines. */
const archives = (...lines: string[]): void => fs.writeFileSync(moduleEnv, lines.join('\n'));

const config = () => loadConfig('archives', moduleEnv);

describe("the catalog's database", () => {
  it('is under DATA_DIR where nothing says otherwise', () => {
    expect(config().catalogDb).toBe('/data/catalog/catalog.db');
  });

  it("is in the archives module's CATALOG_DIR, without -m naming it", () => {
    archives('CATALOG_DIR=/disk/catalog');

    expect(config().catalogDb).toBe('/disk/catalog/catalog.db');
  });

  it("expands what the module's CATALOG_DIR refers to", () => {
    archives('CATALOG_DIR=${DATA_DIR}/elsewhere');

    expect(config().catalogDb).toBe('/data/elsewhere/catalog.db');
  });

  it("is under DATA_DIR where the module's CATALOG_DIR is empty", () => {
    archives('CATALOG_DIR=');

    expect(config().catalogDb).toBe('/data/catalog/catalog.db');
  });

  it("is in the environment's CATALOG_DIR before the module's", () => {
    archives('CATALOG_DIR=/disk/catalog');
    vi.stubEnv('CATALOG_DIR', '/env/catalog');

    expect(config().catalogDb).toBe('/env/catalog/catalog.db');
  });

  it('is CATALOG_DB where that is set', () => {
    archives('CATALOG_DIR=/disk/catalog');
    vi.stubEnv('CATALOG_DB', '/one/where.db');

    expect(config().catalogDb).toBe('/one/where.db');
  });
});

describe("the catalog's URL", () => {
  it("is on the archives module's CATALOG_PORT", () => {
    archives('CATALOG_PORT=9100');

    expect(config()).toMatchObject({ catalogUrl: 'http://localhost:9100', catalogUnknown: null });
  });

  it('is CATALOG_URL where that is set, whatever the module says', () => {
    archives('CATALOG_PORT=');
    vi.stubEnv('CATALOG_URL', 'http://catalog.lan:8080/');

    expect(config()).toMatchObject({ catalogUrl: 'http://catalog.lan:8080', catalogUnknown: null });
  });

  it('is on port 9010 where the module does not set CATALOG_PORT', () => {
    expect(config()).toMatchObject({ catalogUrl: 'http://localhost:9010', catalogUnknown: null });
  });

  it('is not known where the module sets CATALOG_PORT empty, and asking says why', async () => {
    archives('CATALOG_PORT=');

    const fetch = vi.fn();

    vi.stubGlobal('fetch', fetch);

    const unknown = config();

    expect(unknown.catalogUnknown).toMatch(/CATALOG_PORT is empty in .*archives\.env.*CATALOG_URL/);
    await expect(venues(unknown)).rejects.toThrow(/CATALOG_PORT is empty/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('is not known where the module sets CATALOG_PORT to something that is not a port', () => {
    archives('CATALOG_PORT=127.0.0.1:9100');

    expect(config().catalogUnknown).toMatch(/CATALOG_PORT in .*archives\.env is not a port: 127\.0\.0\.1:9100/);
  });
});

describe("the catalog's token", () => {
  it("is the archives module's CATALOG_TOKEN, unless the environment sets one", () => {
    archives('CATALOG_TOKEN=from-module');

    expect(config().catalogToken).toBe('from-module');

    vi.stubEnv('CATALOG_TOKEN', 'from-env');

    expect(config().catalogToken).toBe('from-env');
  });
});
