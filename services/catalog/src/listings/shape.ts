import { logger } from '@devvir/service-kit';
/**
 * What a file's path says about it beyond which series it belongs to: how the
 * file is wrapped.
 *
 * **Read rather than stored, because it is derived.** It is a pure function of
 * the path the venue wrote; a column holding the same thing would be a second
 * copy free to disagree with the path it came from. The listing states it in
 * every key, so a key says what the file is without its URL.
 */

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
 * they hold — see `KNOWN`. One nobody has met is taken for text — `.txt`, or
 * `.txt.gz` for a compressed stream that does not say what it is — and said
 * aloud once per directory per process.
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

/**
 * An ending given to a file whose own says nothing usable. Said once per
 * directory per process, so that it is met early without one warning for each
 * file of a directory that holds thousands alike.
 */
const assumed = (path: string, ending: string): string => {
  const said = `${path.slice(0, Math.max(path.lastIndexOf('/'), 0))}|${ending}`;

  if (! SAID.has(said)) {
    if (SAID.size >= SAID_AT_MOST) SAID.clear();
    SAID.add(said);
    logger.warn({ path, ending }, 'A file with no usable extension — named as text');
  }

  return ending;
};

/** The directories, with the ending assumed there, already warned of. */
const SAID = new Set<string>();

/** How many `SAID` holds before it starts over, so that a process listing without end stays bounded. */
const SAID_AT_MOST = 1_000;
