import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchJson } from '../src/metadata';
import { gateInstruments } from '../src/adapters/gate/instruments';

vi.mock('../src/metadata', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/metadata')>()),
  fetchJson:    vi.fn(),
  metadataGap:  vi.fn(async () => {}),
}));

/**
 * What `live` means for gate.
 *
 * **It means the venue still lists the instrument, never that it can be traded
 * this minute.** Gate's tradfi market is tokenised equities and ETFs, so it
 * follows US market hours and reports every one of its 680 symbols as `closed`
 * outside them — two thirds of every weekday, every weekend, every holiday.
 *
 * Read as a delisting, that retired the whole market on any pass that ran out of
 * hours, and the next pass in hours revived all of it: tips dropped back to the
 * floor and a backfill per symbol walking years down an archive a walk had
 * already read.
 */
const answers = (by: Record<string, unknown>) => {
  vi.mocked(fetchJson).mockImplementation(async (url: string) => {
    for (const [part, body] of Object.entries(by)) if (url.includes(part)) return body as never;

    return [] as never;
  });
};

afterEach(() => vi.mocked(fetchJson).mockReset());

describe('what gate reports as live', () => {
  it('keeps a tradfi symbol live while its market is closed', async () => {
    answers({
      'tradfi/symbols': { data: { list: [
        { symbol: 'AAPL', status: 'closed' },
        { symbol: 'NVDL', status: 'open' },
      ] } },
    });

    const listed = (await gateInstruments()).filter(one => one.market === 'tradfi');

    expect(listed).toEqual([
      { market: 'tradfi', symbol: 'AAPL', live: true },
      { market: 'tradfi', symbol: 'NVDL', live: true },
    ]);
  });

  /** Leaving the listing is what a withdrawal looks like here. */
  it('reports nothing for a tradfi symbol the listing has dropped', async () => {
    answers({ 'tradfi/symbols': { data: { list: [{ symbol: 'NVDL', status: 'open' }] } } });

    const listed = (await gateInstruments()).filter(one => one.market === 'tradfi');

    expect(listed.map(one => one.symbol)).toEqual(['NVDL']);
  });

  /**
   * **The other three markets do carry listing state, and are read as before.**
   * Measured against the live API: 2,232 spot pairs tradable against 2 not, and
   * no contract in delisting at all.
   */
  it('still reads spot and futures listing flags', async () => {
    answers({
      'currency_pairs': [
        { id: 'BTC_USDT', trade_status: 'tradable' },
        { id: 'XAR_USDT', trade_status: 'untradable' },
      ],
      'futures/usdt/contracts': [
        { name: 'BTC_USDT', in_delisting: false },
        { name: 'OLD_USDT', in_delisting: true },
      ],
    });

    const listed = await gateInstruments();

    expect(listed).toContainEqual({ market: 'spot', symbol: 'BTC_USDT', live: true });
    expect(listed).toContainEqual({ market: 'spot', symbol: 'XAR_USDT', live: false });
    expect(listed).toContainEqual({ market: 'perp', symbol: 'BTC_USDT', live: true });
    expect(listed).toContainEqual({ market: 'perp', symbol: 'OLD_USDT', live: false });
  });
});
