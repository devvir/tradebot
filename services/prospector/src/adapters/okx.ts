import { probed } from '../scanners/probed';
import { fetchHead } from '../http';
import { okxInstruments, symbolRanges } from './okx/instruments';
import type { Adapter, OkxContext } from '../types';
import { declare } from './declare';

/**
 * OKX: an archive with no listing at any layer, so its keys are **constructed**.
 *
 * What exists is not discovered by walking. The bounds come from the venue's
 * instruments API and its download portal — see `okx/instruments.ts` — and the
 * scanner turns those bounds into paths, one per instrument, series and period.
 * Nothing is fetched to produce them, so a survey here costs no requests at all
 * and every key it yields is a candidate rather than a sighting.
 *
 * **One host, two prefixes**, which is why `root` stops at the host:
 *
 * ```
 * static.okx.com/cdn/okex/traderecords/…   trades, candlesticks, swaprates, borrowrates
 * static.okx.com/cdn/okx/match/orderbook/… the L2 books
 * ```
 *
 * Not two adapters. An adapter is split by *host* — bybit is two because its
 * books live on `quote-saver.bycsi.com`, a different server with a different
 * shape and its own limiter. Here both prefixes are the same server, and a
 * prefix is only a path; splitting on one would mean splitting on any of them.
 */
export const okx: Adapter = declare({
  name:    'okx',
  scanner: probed,

  /**
   * The portal index, which is the only thing here that answers a question about
   * more than one key — and even then only for windows it is asked about.
   */
  list:    'https://www.okx.com/priapi/v5/broker/public/trade-data/download-link',

  /**
   * **Nothing here is established until it has been asked.**
   *
   * On a listing venue this flag answers "does the listing carry size and
   * checksum". Here there is no listing at all: every key is one this service
   * constructed, so a probe is not filling in metadata — it is the only step
   * that can decide whether the file is there.
   */
  probes:  true,

  /**
   * The ranges the scanner builds keys inside, brought up to date first.
   *
   * **The expensive half of this venue**, and all of it is in
   * `okx/instruments.ts`: the adapter says what a venue is, not how its bounds
   * were come by.
   */
  getContext: async (db): Promise<OkxContext> => {
    return {
      ranges: await symbolRanges(db, okx),
      base:   okx.base,
      root:   okx.root,
      head:   (url: string) => fetchHead(okx, url),
    };
  },

  /**
   * **100 a second, measured.** Sustained `HEAD` load against this host is clean
   * there; 200 was tried and refused, 35 `403`s inside one pass. The refusals
   * came from CloudFront (`cache: "Error from cloudfront"`), not the origin.
   *
   * What makes exceeding the cadence worse here than elsewhere is that the
   * refusal is **sticky** — once tripped, unrelated paths keep being refused for
   * minutes, answering in ~40ms, so a burst poisons the requests after it rather
   * than only itself.
   */
  pacing:  { perSecond: 100, concurrency: 200 },

  /**
   * **A missing key is a `404`; a `403` is the venue refusing us.**
   *
   * Measured against the CDN — an invented symbol and an impossible date both
   * answer 404, and 403 only ever means the cadence was exceeded. So absence
   * here is unambiguous, and one 404 is worth as much as several.
   *
   * **TEMPORARY is only the `'drop'`**, which sets a key down on the first 404
   * rather than leaving it to be confirmed. Re-asking is worth something on a
   * live series' trailing edge, where a 404 served moments before publication is
   * truthful and wrong, and nothing across years long closed — which on a
   * keyspace this empty is the difference between ~69M requests and ~23M. Remove
   * the hook when the experiment is done; the fact above it stays true.
   */
  ruleOnFailure: (status: number) => (status === 404 ? 'drop' : null),

  /** What this venue lists today — its only discovery. */
  instruments: okxInstruments,

  /**
   * **Nothing here can be listed.** okx's CDN, its OSS origin and its website
   * endpoint all refuse `ListObjects`, so there is no keyspace to walk and never
   * was: its series are declared, and every pass is an update over them.
   */
  listable: false,

  dateOf: (path) => {
    const daily = /(\d{4})-(\d{2})-(\d{2})\.(?:zip|tar\.gz)$/.exec(path);

    if (daily) return `${daily[1]}${daily[2]}${daily[3]}`;

    const monthly = /(\d{4})-(\d{2})\.zip$/.exec(path);

    return monthly ? `${monthly[1]}${monthly[2]}` : null;
  },

});
