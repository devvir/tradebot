import { probed } from '../scanners/probed';
import { fetchHead } from '../http';
import { dateOf } from './bitget/shapes';
import { bitgetInstruments, bitgetUrlSymbol } from './bitget/instruments';
import type { Adapter, ProbedContext, Unsettled } from '../types';
import { declare } from './declare';
import { DatabaseSync } from 'node:sqlite';

// See OKX adapter for an explanation of this
let held: DatabaseSync | null = null;

/**
 * Bitget: an archive whose bucket will not admit what it does not have.
 *
 * **The keys are constructed**, as okx's are. Bitget does publish an index — its
 * download portal's own backend, `getPublicDataV2` — but that is a curated view
 * over the bucket rather than a listing of it: it is rate limited, undocumented,
 * keyed by the venue's *display* symbol where paths carry a disambiguated form,
 * and it omits. Measured against 1.46M files held locally it is complete for
 * candlesticks and misses 0.27% of trades and 1.30% of depth, every one of which
 * the CDN serves. The index is therefore a lead; only the CDN settles a key.
 *
 * **A missing key here is a `403`, not a `404`.** The bucket grants `GetObject`
 * and not `ListBucket`, so S3 answers `AccessDenied` for every object it has
 * never held — which is, by status alone, exactly what being turned away looks
 * like. Two hooks below tell the two apart: `refusesUs` says whether a refusal
 * was aimed at us, and `ruleOnFailure` says what it means for the key.
 */
export const bitget: Adapter = declare({
  name:    'bitget',
  scanner: probed,

  /** The portal's own backend — a curated index, and the only thing that answers about more than one key. */
  list:    'https://www.bitget.com/v1/statistics/public/download/getPublicDataV2',

  /**
   * **Nothing here can be listed.** The bucket refuses `ListObjects` and hides
   * absence behind `AccessDenied`, so there is no keyspace to walk: the series
   * are declared and every pass is an update over them.
   */
  listable: false,

  /**
   * **A walk establishes nothing**, so a `HEAD` is what decides whether a
   * constructed key is a file at all — the same arrangement okx has, and for the
   * same reason.
   */
  probes:  true,

  /**
   * **The instrument listing runs first, because the bucket serves none.**
   * Nothing about this venue can be found by reading the archive, so what it
   * lists is the only place a symbol it has never published can come from. What
   * that costs to omit is measured: 585 series bitget's own download index had
   * never mentioned.
   *
   * The context itself is an address and one request; the listing leaves its
   * results in the catalog rather than in what this returns.
   */
  getContext: async (db): Promise<ProbedContext> => {
    /** **TEMPORARY.** See `ruleOnSuccess` — it needs a handle and gets none. */
    held = db;

    return {
      base: bitget.base,
      root: bitget.root,
      head: (url: string) => fetchHead(bitget, url),
    };
  },

  /**
   * **Measured hard, and it has never refused anything.**
   *
   * 597,000 `HEAD`s in one afternoon against keys the catalog says exist, in
   * closed-loop ramps up to 3,506 a second at 400 workers — **zero** non-200
   * answers, zero refusals, no rise in latency, no `Slow Down`. Throughput fell
   * above 400 workers, and that was this machine's own CPU rather than the
   * venue: at 400 lanes it sat at 28% of eight cores with a p50 of 55ms.
   *
   * **What that rules out matters more than the number.** A stand-down seen in
   * production was read as this venue rate-limiting us; it was not. Every one of
   * its `403`s came from S3 saying a key is absent — see `refusesUs` below.
   * The rate was never the problem.
   *
   * **So the rate is deliberately not a limit here.** Ten thousand a second is
   * far above anything this machine or its link can produce, and the figure
   * exists only so that nothing here is the thing holding it back. Every other
   * venue's number bounds where *it* starts refusing; bitget has never refused
   * anything, so there is no such number to write down.
   *
   * `concurrency` is the one that actually decides throughput, since a request
   * spends nearly all its life waiting: 500 lanes against a p50 of 55ms is more
   * than the rate above could ever need. It is set where it is because the pool
   * gets socket-hungry rather than because the venue objects — if this machine
   * struggles, that is the number to lower, not `perSecond`.
   */
  pacing:  { perSecond: 10_000, concurrency: 300 },

  /** What this venue lists today — its only discovery. */
  instruments: bitgetInstruments,
  urlSymbolFor: bitgetUrlSymbol,

  dateOf,

  /**
   * **S3 answering is a statement about the object; CloudFront answering is a
   * statement about us.**
   *
   * A key the bucket does not have comes back `403 AccessDenied` with
   * `server: AmazonS3` and an XML body — the origin was reached and it answered.
   * A CDN turning the address away never reaches the origin and serves its own
   * error, under its own `server`. That is the whole distinction, and it is the
   * only one available on a `HEAD`, which carries no body to read.
   */
  refusesUs: (_status, headers) => headers.get('server') !== 'AmazonS3',

  /**
   * **A 403 from the bucket is this venue's 404.**
   *
   * Every key here is one this service invented from a pattern and a date, and
   * the archive has real gaps inside every range — a day an instrument traded
   * nothing has no trades file. Confirming each of those absences more than once
   * would spend millions of requests establishing what the first answer already
   * did, because here a `403` from the bucket is not a maybe.
   *
   * So it is treated exactly as a 404 is: out of the work list at once, and
   * asked again by tomorrow's update, because "not there now" is not "never".
   */
  ruleOnFailure: (status, headers) =>
    (status === 403 && headers.get('server') === 'AmazonS3' ? 'drop' : null),

  /**
   * **A day of trades is cut into parts, and nothing says how many.**
   *
   * Bitget splits every 100,000 rows — verified by opening the files, in both
   * eras and under every token — into `_001`, `_002`, on to `_101` at the worst.
   * A pattern and a date cannot express that, so each part that arrives asks for
   * the next, and the chain ends where the archive does: the first miss leaves
   * `wip` under the rule above and implies nothing further.
   *
   * **A size threshold was considered and rejected.** A full part is 100,000
   * rows, but its *compressed* size varies with symbol, price precision and era
   * — full parts run from 215,212 bytes upward while terminal parts have a
   * median of 135,981, and the distributions overlap. Guessing costs one `HEAD`
   * saved; guessing wrong costs a silently truncated day.
   */
  // ruleOnSuccess: (row) => {
  //   const next = NEXT_PART.exec(row.path);

  //   if (! next) return null;

  //   return {
  //     action: 'accept',
  //     next:   `${next[1]}${String(Number(next[2]) + 1).padStart(3, '0')}.zip`,
  //   };
  // },

  /**
   * **TEMPORARY — this pass is measuring where each series *starts*, and nothing
   * else.** It replaces the real hook above and goes with it.
   *
   * Generation emits a series' whole range in ascending order, so the first key
   * that answers is that series' first file. Once it has, every later key of that
   * series is a request whose answer this pass has no use for — so they are
   * dropped and the series is finished in one hit.
   *
   * **The cut is now everything above the first, not the span up to `last`.** The
   * older form stopped at the seeded `last` so that one probe confirmed the end
   * as well, which was only worth having while `last` was believed. It is the
   * download index's word, the index under-reports, and a `last` that is wrong
   * low ends the series early — so this pass declines to use it at all and the
   * ends are measured by a later pass, from floors these firsts will have proved.
   *
   * What it costs is that `file` holds one row per series. That is the intended
   * output: the first date, and which series answer nothing at all.
   */
  ruleOnSuccess: (row: Unsettled) => {
    if (held === null || row.seriesId === null) return null;

    held.prepare('DELETE FROM wip WHERE series_id = ? AND date > ?')
      .run(row.seriesId, row.date);

    return null;
  },
});

/** Everything up to the part number, and the part number. Trades only carry one. */
// const NEXT_PART = /^(.*_)(\d{3})\.zip$/;
