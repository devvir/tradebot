import { afterEach, describe, expect, it, vi } from 'vitest';
import { _test_queries as queries } from '../src/adapters/okx/instruments';

/**
 * Listing one market, which is one request everywhere but options.
 *
 * okx refuses `instType=OPTION` on its own — `50015, Either parameter uly or
 * instFamily is required` — so options are fetched per underlying. The two
 * parameters are **not** interchangeable: `instFamily` answers for `BTC-USD` and
 * `ETH-USD` and rejects `SOL-USD` and `XAU-USD`, while `uly` answers for all
 * four, and `uly` is what the underlying endpoint returns.
 */
describe('listing a market', () => {
  const fetching = (body: unknown) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })));
  };

  afterEach(() => vi.unstubAllGlobals());

  it('asks once for a market that can be listed whole', async () => {
    expect(await queries('SPOT')).toEqual(['instType=SPOT']);
    expect(await queries('SWAP')).toEqual(['instType=SWAP']);
  });

  it('asks once per underlying for options, by uly', async () => {
    fetching({ code: '0', data: [['SOL-USD', 'BTC-USD']] });

    expect(await queries('OPTION')).toEqual([
      'instType=OPTION&uly=SOL-USD',
      'instType=OPTION&uly=BTC-USD',
    ]);
  });

  /**
   * An empty underlying list would leave options unasked-about, and everything
   * absent from a listing is retired — so it stops instead.
   */
  it('refuses to proceed with no underlyings', async () => {
    fetching({ code: '0', data: [[]] });

    await expect(queries('OPTION')).rejects.toThrow(/no option underlyings/);
  });
});

