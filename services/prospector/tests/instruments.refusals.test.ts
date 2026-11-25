import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { putVenue, recordSeries, seriesFor } from '../src/catalog';
import { openCatalog } from '../src/database';
import { fetchJson } from '../src/metadata';
import { preamble } from '../src/preamble';
import { s3 } from '../src/scanners/s3';
import { bybitInstruments } from '../src/adapters/bybit/instruments';
import { htxInstruments } from '../src/adapters/htx/instruments';
import { kucoinInstruments } from '../src/adapters/kucoin/instruments';
import type { DatabaseSync } from 'node:sqlite';
import type { Adapter } from '../src/types';

/**
 * A venue API that answers `200` with an error inside.
 *
 * **An error is not an empty list.** Read as one, every instrument the failed
 * call would have named is missing from the listing, and the preamble takes
 * missing for delisted. So a refusal, a body without a list and a listing cut
 * short all fail the listing, and the preamble changes nothing.
 */

let dir: string;
let db:  DatabaseSync;

/** Answers by the first part of the URL that matches; anything else is a 404. */
const serve = (by: [part: string, status: number, body: unknown][]) => {
  const calls: string[] = [];

  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    calls.push(url);

    const hit = by.find(([part]) => url.includes(part));

    return hit
      ? new Response(JSON.stringify(hit[2]), { status: hit[1], headers: { 'content-type': 'application/json' } })
      : new Response('not found', { status: 404 });
  }));

  return calls;
};

/** Runs a promise to its end with every retry's wait skipped. */
const settled = async <T>(running: Promise<T>): Promise<PromiseSettledResult<T>> => {
  const out = Promise.allSettled([running]).then(([one]) => one!);

  await vi.runAllTimersAsync();

  return out;
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'instruments-'));
  db  = openCatalog(join(dir, 'catalog.db'), { seedData: false });

  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('fetchJson', () => {
  it('asks again after a server fault', async () => {
    let calls = 0;

    vi.stubGlobal('fetch', vi.fn(async () => (++calls === 1
      ? new Response('busy', { status: 503 })
      : new Response('{"ok":true}', { status: 200 }))));

    const out = await settled(fetchJson<{ ok: boolean }>('https://api.example/x', 'demo'));

    expect(out).toEqual({ status: 'fulfilled', value: { ok: true } });
    expect(calls).toBe(2);
  });

  it('does not ask again after a refusal of the request itself', async () => {
    const calls = serve([['/x', 400, { no: true }]]);

    const out = await settled(fetchJson('https://api.example/x', 'demo'));

    expect(out.status).toBe('rejected');
    expect(calls).toHaveLength(1);
  });

  it('fails on a body the venue says is a refusal, once its attempts are spent', async () => {
    const calls = serve([['/x', 200, { code: 1 }]]);

    const out = await settled(fetchJson('https://api.example/x', 'demo', b => (b as { code: number }).code !== 0));

    expect(out).toMatchObject({ status: 'rejected', reason: expect.objectContaining({ message: expect.stringContaining('refused') }) });
    expect(calls.length).toBeGreaterThan(1);
  });
});

describe('bybit', () => {
  const HOST = 'api.bybit.com';

  const ok = (list: unknown[], nextPageCursor = '') => ({ retCode: 0, retMsg: 'OK', result: { list, nextPageCursor } });

  beforeEach(() => putVenue(db, 'bybit', 'https://x', '', HOST));

  it('fails the listing when one category answers with an error', async () => {
    serve([
      ['category=inverse', 200, { retCode: 10006, retMsg: 'Too many visits!', result: {} }],
      ['category=', 200, ok([{ symbol: 'BTCUSDT', status: 'Trading' }])],
    ]);

    expect((await settled(bybitInstruments(db, HOST))).status).toBe('rejected');
  });

  it('fails the listing when an answer carries no list', async () => {
    serve([['category=', 200, { retCode: 0, result: {} }]]);

    expect((await settled(bybitInstruments(db, HOST))).status).toBe('rejected');
  });

  it('fails the listing when the page cap is reached with a cursor still to follow', async () => {
    serve([['category=', 200, ok([{ symbol: 'BTCUSDT', status: 'Trading' }], 'more')]]);

    const out = await settled(bybitInstruments(db, HOST));

    expect(out).toMatchObject({ status: 'rejected',
      reason: expect.objectContaining({ message: expect.stringContaining('cursor not exhausted') }) });
  });

  it('lists every category when every one answers', async () => {
    serve([
      ['category=inverse', 200, ok([{ symbol: 'BTCUSD', status: 'Trading' }])],
      ['category=', 200, ok([{ symbol: 'BTCUSDT', status: 'Trading' }])],
    ]);

    const out = await settled(bybitInstruments(db, HOST));

    expect(out.status).toBe('fulfilled');
    expect((out as PromiseFulfilledResult<unknown[]>).value)
      .toContainEqual({ market: 'perp', symbol: 'BTCUSD', live: true });
  });

  /** The case the refusal guards: one perpetual category failing while the other answers. */
  it('leaves the series of a category that failed as they were', async () => {
    const id = putVenue(db, 'demo', 'https://demo.example', '');

    for (const symbol of ['BTCUSDT', 'BTCUSD'])
      recordSeries(db, id, { market: 'perp', dataset: 'trades', symbol, pattern: 'x/{YYYY}{MM}{DD}/{SYMBOL}.zip' },
        { tip: '20260720', first: '20240101' });

    const before = seriesFor(db, id);

    serve([
      ['category=inverse', 200, { retCode: 10006, retMsg: 'Too many visits!', result: {} }],
      ['category=', 200, ok([{ symbol: 'BTCUSDT', status: 'Trading' }])],
    ]);

    const adapter: Adapter = {
      name: 'demo', scanner: s3, base: 'https://demo.example', keyRoot: '',
      dateOf:      (path) => /(\d{8})/.exec(path)?.[1] ?? null,
      instruments: async () => bybitInstruments(db, HOST),
    };

    expect((await settled(preamble(db, adapter, id))).status).toBe('rejected');
    expect(seriesFor(db, id)).toEqual(before);
  });
});

describe('htx', () => {
  const ok = { status: 'ok', data: [] };

  it('fails the listing when a swap endpoint answers with an error', async () => {
    serve([
      ['linear-swap-api', 200, { status: 'error', err_code: 1032, err_msg: 'Maximum number of access attempts exceeded.' }],
      ['huobi.pro', 200, { code: 200, data: [] }],
      ['hbdm.com', 200, ok],
    ]);

    expect((await settled(htxInstruments(db))).status).toBe('rejected');
  });

  it('fails the listing when the spot endpoint answers with an error code', async () => {
    serve([
      ['huobi.pro', 200, { code: 500, message: 'internal error' }],
      ['hbdm.com', 200, ok],
    ]);

    expect((await settled(htxInstruments(db))).status).toBe('rejected');
  });

  it('lists every endpoint when every one answers', async () => {
    serve([
      ['huobi.pro', 200, { status: 'ok', data: [{ bc: 'btc', qc: 'usdt', state: 'online' }] }],
      ['linear-swap-api', 200, { status: 'ok', data: [{ contract_code: 'BTC-USDT', contract_status: 1 }] }],
      ['hbdm.com', 200, ok],
    ]);

    const out = await settled(htxInstruments(db));

    expect(out).toEqual({ status: 'fulfilled', value: [
      { market: 'spot', symbol: 'BTC-USDT', live: true },
      { market: 'perp', symbol: 'BTC-USDT', live: true },
    ] });
  });
});

describe('kucoin', () => {
  it('fails the listing when an endpoint answers with an error code', async () => {
    serve([
      ['api-futures', 200, { code: '400100', msg: 'Unsupported' }],
      ['api.kucoin.com', 200, { code: '200000', data: [] }],
    ]);

    expect((await settled(kucoinInstruments())).status).toBe('rejected');
  });

  it('fails the listing when an answer carries no list', async () => {
    serve([['kucoin.com', 200, { code: '200000', data: null }]]);

    expect((await settled(kucoinInstruments())).status).toBe('rejected');
  });

  it('lists both endpoints when both answer', async () => {
    serve([
      ['api-futures', 200, { code: '200000', data: [{ symbol: 'XBTUSDTM', status: 'Open' }] }],
      ['api.kucoin.com', 200, { code: '200000', data: [{ symbol: 'BTC-USDT', enableTrading: true }] }],
    ]);

    expect(await settled(kucoinInstruments())).toEqual({ status: 'fulfilled', value: [
      { market: 'spot', symbol: 'BTC-USDT', live: true },
      { market: 'perp', symbol: 'XBTUSDTM', live: true },
    ] });
  });
});
