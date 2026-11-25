import { describe, it, expect } from 'vitest';
import { DATA_DIR, tableDir, yearDir, openPath, closedPath } from '../../src/fs/paths';

describe('paths', () => {
  it('builds bucket paths under the data directory', () => {
    expect(tableDir('trade')).toBe(`${DATA_DIR}/trade`);
    expect(yearDir('trade', '20240101')).toBe(`${DATA_DIR}/trade/2024`);
    expect(openPath('trade', '20240101.snapshot')).toBe(`${DATA_DIR}/trade/2024/20240101.snapshot.csv.gz.tmp`);
    expect(closedPath('orderBookL2.secondary', '20240101')).toBe(`${DATA_DIR}/orderBookL2.secondary/2024/20240101.csv.gz`);
  });

  it.each([
    ['closedPath', () => closedPath('x', '20240101./../../../../../live/n')],
    ['openPath',   () => openPath('../..', '20240101')],
    ['openPath',   () => openPath('trade', '20240101/../../../../etc/x')],
    ['tableDir',   () => tableDir('..')],
    ['tableDir',   () => tableDir('')],
    ['yearDir',    () => yearDir('trade', '../../x')],
  ])('%s throws for a path that leaves the data directory', (_name, build) => {
    expect(build).toThrow(/outside the data directory/);
  });
});
