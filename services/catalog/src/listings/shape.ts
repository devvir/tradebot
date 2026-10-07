import { logger } from '@devvir/service-kit';
/**
 * What a pattern and a path say about a file, beyond which series it belongs to.
 *
 * **Read rather than stored, because it is derived.** A pattern is a constant of
 * the venue's archive and these are pure functions of it; a column holding the
 * same thing would be a second copy free to disagree with the shape it came
 * from. They are computed once per pattern — a few hundred rows across every
 * venue — not once per file.
 *
 * Everything here exists for the downloader, which is deliberately blind to
 * URLs: it decides where a file belongs from what the file *is*, so the listing
 * has to state the parts of that which only the shape knows.
 */

/**
 * The bar length a pattern names, if it names one.
 *
 * **A whole path segment, or bybit's filename token.** Every venue that bins its
 * data puts the length in a directory of its own — `…/{SYMBOL}/15min/…` — except
 * bybit's MetaTrader feed, which writes it between two underscores in the
 * filename and means minutes by it. Gate is the third case and is not handled
 * here at all: it spells the length into the *dataset* name, which the consumer
 * already has.
 *
 * A venue that bins its data and names no length anywhere — okx and bitget —
 * answers nothing, and the length is a measured property of the series that the
 * consumer must declare.
 */
export const intervalOf = (pattern: string): string | undefined => {
  const segment = pattern.split('/').find(one => DURATION.test(one));

  if (segment) return segment;

  return pattern.match(BYBIT_MINUTES)?.[1];
};

/**
 * A file's ending: how it is wrapped, said the same way whatever its venue wrote.
 *
 * **Always a valid one.** The last extension — and, where that compresses one
 * stream, the extension before it saying what the stream is: `.csv.gz`,
 * `.tar.gz`. An archive names its own members, so whatever a venue writes in
 * front of `.zip` is dropped: `.data.zip` and `.trades.csv.zip` are both `.zip`.
 *
 * **Where a venue gives none, or a wrong one, it is put right here**, so that
 * nobody reading a listing has to. The files known to be so are named for what
 * they hold — see `KNOWN`. One nobody has met is taken for text and said aloud,
 * every time it is listed: `.txt`, or `.txt.gz` for a compressed stream that
 * does not say what it is.
 */
export const extensionOf = (path: string): string => {
  const known = KNOWN.find(one => one.paths.test(path));

  if (known) return known.ending;

  const parts = path.slice(path.lastIndexOf('/') + 1).split('.').slice(1).map(part => part.toLowerCase());
  const last  = parts.at(-1);

  if (last === undefined || ! EXTENSION.test(last)) return assumed(path, '.txt');

  if (! COMPRESSORS.has(last)) return `.${last}`;

  const inner = parts.at(-2);

  return inner !== undefined && EXTENSION.test(inner) ? `.${inner}.${last}` : assumed(path, `.txt.${last}`);
};

// ── Internals ─────────────────────────────────────────────────────────────────

/** What compresses one stream and names nothing inside it. */
const COMPRESSORS = new Set(['gz', 'bz2', 'xz', 'zst']);

/** What an extension looks like: letters and digits, a letter among them — `7z` is one, `08` is not. */
const EXTENSION = /^[0-9a-z]*[a-z][0-9a-z]*$/;

/**
 * Files their venue names wrongly or not at all, and the ending they are given.
 *
 * - gate's book snapshots are a JSON object a line, gzipped, and named `.gz`;
 * - gate's files named by an instant are space-separated text with no
 *   extension at all.
 */
const KNOWN: { paths: RegExp; ending: string }[] = [
  { paths: /(?:^|\/)orderbooks_slice\/[^/]+\/[^/]+\.gz$/, ending: '.json.gz' },
  { paths: /(?:^|\/)slice_[a-z_]+_\d+$/,                  ending: '.txt' },
];

/** An ending given to a file whose own says nothing usable. Said each time, so that it is met early. */
const assumed = (path: string, ending: string): string => {
  logger.warn({ path, ending }, 'A file with no usable extension — named as text');

  return ending;
};

/**
 * A segment that is a length and nothing else.
 *
 * Anchored at both ends deliberately: `candlesticks_10s` names a length too, but
 * it is a dataset name, and a rule loose enough to find the length inside it
 * would also find one inside a symbol.
 */
const DURATION = /^\d+(?:s|m|min|h|hour|d|day|w|week|mo|mon|month)$/i;

/**
 * Bybit's MetaTrader klines: `…/{SYMBOL}_15_{YYYY}-{MM}-01_…`. The number is the
 * bar length in minutes and carries no unit, which is why it cannot be matched
 * by the same rule as everything else.
 */
const BYBIT_MINUTES = /\{SYMBOL\}_(\d+)_\{/;
