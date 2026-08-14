import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { _test_judge as judge, _test_vaultIds as vaultIds } from '../../../src/tools/cold/evict/archives';
import type { ColdConfig } from '../../../src/tools/cold/types';
import type { DatabaseSync } from 'node:sqlite';

/**
 * Eviction is the one irreversible step, so these are the tests that matter
 * most: every case where a month must **not** go.
 */
const cold = (over: Record<string, { bytes: number; mtime: number }>) => new Map(Object.entries(over));

const file = (bytes = 10, mtime = 1) => ({ bytes, mtime });

const ids = (over: Record<string, string[]>) => new Map(Object.entries(over));

describe('deciding whether a venue-month can be evicted', () => {
  const built    = ids({ 'gate/a': ['trades|gate|spot|A|2018-01'] });
  const backedUp = new Set(['trades|gate|spot|A|2018-01']);

  it('clears a month whose disk and cold copies agree', () => {
    const verdict = judge('gate', '201801',
      cold({ 'gate/a': file() }), cold({ 'gate/a': file() }), built, backedUp);

    expect(verdict.verdict).toBe('clear');
    expect(verdict.files).toEqual(['gate/a']);
  });

  /** Deleting it would destroy the only copy. */
  it('blocks on a file Mega has never seen', () => {
    const verdict = judge('gate', '201801',
      cold({ 'gate/a': file() }),
      cold({ 'gate/a': file(), 'gate/new': file() }),
      ids({ 'gate/a': ['trades|gate|spot|A|2018-01'], 'gate/new': ['trades|gate|spot|A|2018-01'] }),
      backedUp);

    expect(verdict.verdict).toBe('blocked');
    expect(verdict.reasons[0]).toMatch(/never seen/);
    expect(verdict.files).toEqual([]);
  });

  /** The copy in Mega is of something else, so it is not a backup of this. */
  it('blocks on a file whose size or mtime moved', () => {
    expect(judge('gate', '201801',
      cold({ 'gate/a': file(10, 1) }), cold({ 'gate/a': file(11, 1) }), built, backedUp).verdict)
      .toBe('blocked');

    expect(judge('gate', '201801',
      cold({ 'gate/a': file(10, 1) }), cold({ 'gate/a': file(10, 2) }), built, backedUp).verdict)
      .toBe('blocked');
  });

  /**
   * The alignment gate. Raw that reached no partition is either something
   * trucker should stop collecting or something stocker should model, and
   * evicting it would settle that by forgetting it.
   */
  it('blocks on raw that never reached the vault', () => {
    const verdict = judge('gate', '201801',
      cold({ 'gate/a': file(), 'gate/spot/candlesticks_7d/x': file() }),
      cold({ 'gate/a': file(), 'gate/spot/candlesticks_7d/x': file() }),
      built, backedUp);

    expect(verdict.verdict).toBe('blocked');
    expect(verdict.reasons.join(' ')).toMatch(/never reached the vault/);
  });

  /** Built, but the parquet is not itself backed up yet — so the chain is open. */
  it('blocks while the partition it fed is not in Mega', () => {
    const verdict = judge('gate', '201801',
      cold({ 'gate/a': file() }), cold({ 'gate/a': file() }), built, new Set());

    expect(verdict.verdict).toBe('blocked');
    expect(verdict.reasons.join(' ')).toMatch(/partition is not in Mega/);
  });

  /**
   * Nothing to lose — what is missing is already missing — but something removed
   * raw outside this command, so it is asked separately.
   */
  it('flags rather than blocks when raw is already partly gone', () => {
    const verdict = judge('gate', '201801',
      cold({ 'gate/a': file(), 'gate/b': file() }), cold({ 'gate/a': file() }), built, backedUp);

    expect(verdict.verdict).toBe('risky');
    expect(verdict.files).toEqual(['gate/a']);
    expect(verdict.reasons[0]).toMatch(/already gone from disk/);
  });

  /** A real problem outranks a caveat: blocked is blocked. */
  it('blocks rather than flags when both apply', () => {
    expect(judge('gate', '201801',
      cold({ 'gate/a': file(), 'gate/b': file() }),
      cold({ 'gate/a': file(11, 1) }),
      built, backedUp).verdict).toBe('blocked');
  });

  /**
   * A month this command already emptied is finished, not risky.
   *
   * Every file is recorded in cold storage and none is on disk — which is what
   * a successful eviction leaves behind. Reading that as a caveat offered a
   * deletion worth zero bytes, and since the record is never removed, every
   * month ever evicted stayed on the offer for good: 62 of them buried the two
   * that actually had something to reclaim.
   */
  it('reports a month with nothing left on disk as already reclaimed', () => {
    const verdict = judge('gate', '201801',
      cold({ 'gate/a': file(), 'gate/b': file() }), cold({}), built, backedUp);

    expect(verdict.verdict).toBe('reclaimed');
    expect(verdict.files).toEqual([]);
    expect(verdict.bytes).toBe(0);
    expect(verdict.reasons).toEqual([]);
  });

  /** Partly gone still means partly there, which is the only case worth asking about. */
  it('keeps the caveat when part of the month survives', () => {
    const verdict = judge('gate', '201801',
      cold({ 'gate/a': file(), 'gate/b': file() }), cold({ 'gate/a': file() }), built, backedUp);

    expect(verdict.verdict).toBe('risky');
    expect(verdict.bytes).toBeGreaterThan(0);
  });
});

describe('rebuilding a partition id from what cold storage recorded', () => {
  const rows = (over: Record<string, unknown>[]) =>
    ({ prepare: () => ({ all: () => over }) }) as unknown as DatabaseSync;

  /** No vault on disk, so nothing can be read as drifted. */
  const nowhere = { vaultRoot: '/nowhere' } as ColdConfig;

  it('reproduces the id stocker writes, extras and all', () => {
    expect(vaultIds(rows([{
      venue: 'binance', market: 'spot', symbol: 'BCCBTC',
      dataset: 'klines', variant: 'interval=1w', month: '201707',
    }]), nowhere, 'binance')).toEqual(new Set(['klines|binance|spot|BCCBTC|1w|2017-07']));
  });

  it('omits the extras a partition does not carry', () => {
    expect(vaultIds(rows([{
      venue: 'binance', market: 'spot', symbol: 'BNBBTC',
      dataset: 'trades', variant: null, month: '201707',
    }]), nowhere, 'binance')).toEqual(new Set(['trades|binance|spot|BNBBTC|2017-07']));
  });

  /** Several extras keep the order the path wrote them in, which `idOf` shares. */
  it('keeps multiple extras in path order', () => {
    expect(vaultIds(rows([{
      venue: 'gate', market: 'perp', symbol: 'BTC_USD',
      dataset: 'funding', variant: 'kind=realised', month: '201901',
    }]), nowhere, 'gate')).toEqual(new Set(['funding|gate|perp|BTC_USD|realised|2019-01']));
  });
});

/**
 * Stocker rewrites a partition in place when its inputs change, so what Mega
 * holds can be a thinner version of what is on disk — and the raw about to be
 * deleted is what the *current* one was built from.
 *
 * Bitget's klines did exactly this: rebuilt from one of their two published
 * layouts at a time, thirty-five months read as fully normalised and were
 * offered for eviction while their partitions held half their rows.
 */
describe('a partition Mega holds an older copy of', () => {
  const withVault = (bytes: number, mtime: number, recorded: { bytes: number; mtime: number }) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evict-drift-'));
    const rel  = 'venue=binance/market=spot/B/symbol=BCCBTC/klines.parquet';

    fs.mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), 'x'.repeat(bytes));
    fs.utimesSync(path.join(root, rel), mtime / 1000, mtime / 1000);

    const row = {
      venue: 'binance', market: 'spot', symbol: 'BCCBTC', dataset: 'klines',
      variant: 'interval=1w', month: '201707', path: rel,
      bytes: recorded.bytes, mtime: recorded.mtime,
    };

    return {
      config: { vaultRoot: root } as ColdConfig,
      db: ({ prepare: () => ({ all: () => [row] }) }) as unknown as DatabaseSync,
    };
  };

  it('does not count as backed up', () => {
    const stat  = fs.statSync;
    const { config, db } = withVault(20, 1_700_000_000_000, { bytes: 10, mtime: 1_700_000_000_000 });

    void stat;
    expect(vaultIds(db, config, 'binance')).toEqual(new Set());
  });

  it('counts when the local file still matches', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evict-match-'));
    const rel  = 'p.parquet';

    fs.writeFileSync(path.join(root, rel), 'x'.repeat(10));

    const mtime = Math.floor(fs.statSync(path.join(root, rel)).mtimeMs);
    const db    = ({ prepare: () => ({ all: () => [{
      venue: 'binance', market: 'spot', symbol: 'BCCBTC', dataset: 'klines',
      variant: 'interval=1w', month: '201707', path: rel, bytes: 10, mtime,
    }] }) }) as unknown as DatabaseSync;

    expect(vaultIds(db, { vaultRoot: root } as ColdConfig, 'binance'))
      .toEqual(new Set(['klines|binance|spot|BCCBTC|1w|2017-07']));
  });

  /**
   * Gone locally is not drift — it is the steady state this whole family aims
   * at: backed up, then reclaimed.
   */
  it('still counts once the partition has been evicted', () => {
    const db = ({ prepare: () => ({ all: () => [{
      venue: 'binance', market: 'spot', symbol: 'BCCBTC', dataset: 'klines',
      variant: 'interval=1w', month: '201707', path: 'gone.parquet', bytes: 10, mtime: 1,
    }] }) }) as unknown as DatabaseSync;

    expect(vaultIds(db, { vaultRoot: '/nowhere' } as ColdConfig, 'binance'))
      .toEqual(new Set(['klines|binance|spot|BCCBTC|1w|2017-07']));
  });
});
