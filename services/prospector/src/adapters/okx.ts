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
 * **One host, two prefixes**, both under `cdn/` — so the address ends at `cdn/`
 * and each key starts with its prefix:
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
      keyRoot: okx.keyRoot,
      head:   (url: string) => fetchHead(okx, url),
    };
  },

  /**
   * **Limited between 100 and 200 a second.** At 200/s okx's CloudFront edge
   * blocked us 7 times in ~80 minutes (2026-09-29) with `403`s that stay
   * sticky for minutes, refusing unrelated paths too. 100/s has been clean.
   */
  pacing:  { perSecond: 100, concurrency: 100 },

  /**
   * How far behind today this venue is worth asking about.
   *
   * **Measured from the venue's own `Last-Modified`**, 2026-09-25 over the files
   * of 2026-09-15 to 21: p99 24.4 hours after the dated day begins, over 61,018 files — the promptest of the eight, and still past midnight.
   *
   * **Every venue publishes more than a day after its period begins**, so a pass
   * running in the small hours finds nothing for yesterday whatever the catalog's
   * newest file suggests — a snapshot taken in the afternoon says only that the
   * file had arrived by the afternoon.
   *
   * **A day further back again**, because a publishing hour that drifts later
   * would put the frontier in front of the archive. Asking early costs a probe
   * per series per night, every night, for a period that cannot exist yet; asking
   * late costs the catalog's edge a day, and loses nothing — the frontier
   * advances daily and the patience window covers what it has not reached.
   */
  probingLag: 3,

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
  ruleOnFailure: (_row, status) => (status === 404 ? 'drop' : null),

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
