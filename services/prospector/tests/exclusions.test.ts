import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { bybitPrimary } from '../src/adapters/bybit.primary';
import { bybitSecondary } from '../src/adapters/bybit.secondary';
import { putVenue } from '../src/catalog';
import { listing } from '../src/context';
import { openCatalog } from '../src/database';
import { _test_reset, isExcluded, loadExclusions } from '../src/exclusions';
import { _test_accepted } from '../src/scanners/s3';

let dir: string;
let db:  DatabaseSync;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'exclusions-'));
  db  = openCatalog(join(dir, 'catalog.db'), { seedData: false });
});

afterEach(() => {
  _test_reset();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const exclude = (venueId: number, path: string): void => {
  db.prepare('INSERT INTO exclusion (venue_id, path, reason) VALUES (?, ?, ?)')
    .run(venueId, path, 'test');
};

/**
 * A venue served from several hosts has one `venue` row per host, and each row
 * carries its own exclusions. Both servers share the venue's name, so the sets
 * must be told apart by server, not by name.
 */
describe('exclusions on a venue with two servers', () => {
  const primaryOnly   = 'trading/AAA/AAA2021-01-01.csv.gz';
  const secondaryOnly = 'orderbook/BBB/2021-01-01_BBB_ob500.data.zip';

  beforeEach(() => {
    const primary   = putVenue(db, bybitPrimary.name, 'https://primary.example', '', bybitPrimary.host);
    const secondary = putVenue(db, bybitSecondary.name, 'https://secondary.example', '', bybitSecondary.host);

    exclude(primary, primaryOnly);
    exclude(secondary, secondaryOnly);

    loadExclusions(db, bybitPrimary, primary);
    loadExclusions(db, bybitSecondary, secondary);
  });

  it('excludes on each server exactly the paths of its own rows', () => {
    expect(isExcluded(bybitPrimary, primaryOnly)).toBe(true);
    expect(isExcluded(bybitPrimary, secondaryOnly)).toBe(false);

    expect(isExcluded(bybitSecondary, secondaryOnly)).toBe(true);
    expect(isExcluded(bybitSecondary, primaryOnly)).toBe(false);
  });

  it('answers the same through each server\'s listing context', () => {
    expect(_test_accepted(listing(bybitPrimary), primaryOnly)).toBe(false);
    expect(_test_accepted(listing(bybitSecondary), primaryOnly)).toBe(true);
  });

  /** A job reloads its own server's set when it starts; the other's is untouched. */
  it('reloading one server neither replaces nor clears the other\'s set', () => {
    const secondary = putVenue(db, bybitSecondary.name, 'https://secondary.example', '', bybitSecondary.host);

    db.prepare('DELETE FROM exclusion WHERE venue_id = ?').run(secondary);
    loadExclusions(db, bybitSecondary, secondary);

    expect(isExcluded(bybitSecondary, secondaryOnly)).toBe(false);
    expect(isExcluded(bybitPrimary, primaryOnly)).toBe(true);
  });
});
