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
 * A file's extension, from the first dot of its name to the end.
 *
 * **Not the last dot.** `.csv.gz`, `.tar.gz` and `.data.zip` are all one
 * extension in two or three parts, and taking only `.gz` would leave the rest
 * looking like part of the name. No venue in the catalog puts a dot in a symbol
 * or a date, so the first dot is always where the name stops.
 *
 * Gate's slices carry no extension at all, and answer the empty string.
 */
export const extensionOf = (path: string): string => {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot  = name.indexOf('.');

  return dot === -1 ? '' : name.slice(dot);
};

/**
 * Which of a period's files this one is, where a venue splits a period at all.
 *
 * **Only where the pattern says the venue does.** Bitget cuts a day of trades
 * every hundred thousand rows and numbers the pieces, reaching `_101`; nothing
 * else in the catalog does. Requiring the *pattern* to carry the same shape is
 * what stops this firing on a venue whose filenames merely end in digits — a
 * date, a strike, an expiry.
 */
export const partOf = (path: string, pattern: string): string | undefined => {
  if (! PARTED.test(stem(pattern))) return undefined;

  return stem(path).match(PARTED)?.[1];
};

// ── Internals ─────────────────────────────────────────────────────────────────

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

/** A trailing `_NNN` on the name, before any extension. */
const PARTED = /_(\d{3})$/;

/** The last segment with its extension taken off, which is where a part sits. */
const stem = (of: string): string =>
  of.slice(of.lastIndexOf('/') + 1).replace(/\..*$/, '');
