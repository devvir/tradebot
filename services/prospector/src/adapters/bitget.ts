import { probed } from '../scanners/probed';
import { fetchHead } from '../http';
import { dateOf } from './bitget/shapes';
import { bitgetInstruments, bitgetUrlSymbol } from './bitget/instruments';
import type { Adapter, ProbedContext } from '../types';
import { declare } from './declare';

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
  getContext: async (): Promise<ProbedContext> => ({
    base: bitget.base,
    keyRoot: bitget.keyRoot,
    head: (url: string) => fetchHead(bitget, url),
  }),

  /**
   * **CloudFront's own limit sits near 2,900/s.** Measured 2026-09-30: at 500
   * in flight the service averaged ~2,900/s over ten seconds and the edge
   * answered `503 LimitExceeded from cloudfront`, standing the venue down.
   * Capped at 2,500 it held ~2,300/s for as long as it was watched. A missing
   * key takes ~235 ms, the edge asking the origin, so 600 at once reaches the
   * cap. A missing key here is a `403` — see `refusesUs` — which is not a
   * refusal of us.
   */
  pacing:  { perSecond: 2500, concurrency: 500 },

  /**
   * How far behind today this venue is worth asking about.
   *
   * **Measured from the venue's own `Last-Modified`**, 2026-09-25 over the files
   * of 2026-09-15 to 21: p99 52.9 hours after the dated day begins, over 28,992 files — more than twice any other venue, and the reason this one is a day further back again.
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
  probingLag: 4,

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
  ruleOnFailure: (_row, status, headers) =>
    (status === 403 && headers.get('server') === 'AmazonS3' ? 'drop' : null),

  /**
   * **A day of trades is cut into parts, and nothing says how many.**
   *
   * Bitget splits every 100,000 rows — verified by opening the files, in both
   * eras and under every token — into `_001`, `_002`, on to `_101` at the worst.
   * Nothing in a path, a listing or a date says where a day stops, so each part
   * that arrives asks for the next and the chain ends where the archive does:
   * the first miss ends the day and implies nothing further.
   *
   * **Which is why the answer matters and the count does not.** A venue that
   * knows its own partitioning can name every part at once — gate does — and
   * this one cannot, so it names them one at a time. The core treats both the
   * same way.
   *
   * **A size threshold was considered and rejected.** A full part is 100,000
   * rows, but its *compressed* size varies with symbol, price precision and era
   * — full parts run from 215,212 bytes upward while terminal parts have a
   * median of 135,981, and the distributions overlap. Guessing costs one `HEAD`
   * saved; guessing wrong costs a silently truncated day.
   */
  expandParts: ({ lastPartFound, nextPart }) => {
    if (lastPartFound === null) return { parts: FIRST_PART, next: after(FIRST_PART) };

    return lastPartFound ? { parts: nextPart, next: after(nextPart) } : null;
  },
});

/** Where every day starts. A day with no first part is a day with nothing in it. */
const FIRST_PART = '001';

/** The part bitget numbers after this one, in the width it numbers them in. */
const after = (part: string): string => String(Number(part) + 1).padStart(3, '0');
