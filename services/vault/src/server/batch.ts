/**
 * Coalesces a stream of lines into chunks of at least `size` characters, so a
 * response is written in a few large chunks rather than one per line. Lines are
 * joined unchanged and never split: every chunk ends where a line ends, and the
 * last chunk holds whatever remains, however short.
 */
export async function* batchLines(
  lines: AsyncIterable<string>,
  size:  number,
): AsyncGenerator<string> {
  let parts:  string[] = [];
  let length = 0;

  for await (const line of lines) {
    parts.push(line);
    length += line.length;

    if (length >= size) {
      yield parts.join('');
      parts  = [];
      length = 0;
    }
  }

  if (parts.length > 0) yield parts.join('');
}
