/**
 * Content-key derivation shared by `data dedup` (prune) and `data prepare`
 * (deduper). A key identifies a message by its content with `_date_` stripped —
 * everything from row 0's first comma onward, continuation rows joined with
 * `\n` — so the same BitMEX event yields the same key regardless of reception
 * time. The same event always collides; a fresh event (different timestamps)
 * gets a different key.
 *
 * Keys at or under `MAX_LITERAL_KEY` bytes are kept verbatim (exact, collision-
 * free, cheap for single-row deltas). Longer ones — partials / full-book
 * snapshots, tens of thousands of rows — are replaced by a compact 64-bit hash
 * so a seen-set never holds multi-MB strings and exhausts the heap. The branch
 * is purely length-based; `action` is never inspected. A hash key is prefixed
 * with `\0`, which a literal key (starting at a real CSV character) never is, so
 * the two key spaces stay disjoint.
 *
 * Assumes single-byte content (numeric/ASCII CSV), so `String.length` is an
 * exact byte count.
 */

export const MAX_LITERAL_KEY = 500;

/** Content key of a message's rows, literal when small, hashed when large. */
export function contentKey(rows: string[]): string {
  const first      = rows[0]!;
  const firstComma = first.indexOf(',');

  if (rows.length === 1) {
    return first.length - firstComma <= MAX_LITERAL_KEY ? first.slice(firstComma) : hashKey(rows);
  }

  let len = first.length - firstComma;

  for (let r = 1; r < rows.length; r++) len += rows[r]!.length + 1;

  return len <= MAX_LITERAL_KEY ? rows.join('\n').slice(firstComma) : hashKey(rows);
}

/**
 * 64-bit hash (FNV-1a + djb2-xor) over the same content the literal key covers —
 * `rows[0]` from its first comma onward, then each continuation row prefixed
 * with `\n` — computed incrementally so the large snapshot string is never
 * built.
 */
export function hashKey(rows: string[]): string {
  const first = rows[0]!;
  const start = first.indexOf(',');

  let h1 = 0x811c9dc5; // FNV-1a offset basis
  let h2 = 5381;       // djb2

  for (let i = start < 0 ? 0 : start; i < first.length; i++) {
    const c = first.charCodeAt(i);

    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2, 33) ^ c;
  }

  for (let r = 1; r < rows.length; r++) {
    h1 = Math.imul(h1 ^ 10, 0x01000193);
    h2 = Math.imul(h2, 33) ^ 10;

    const row = rows[r]!;

    for (let i = 0; i < row.length; i++) {
      const c = row.charCodeAt(i);

      h1 = Math.imul(h1 ^ c, 0x01000193);
      h2 = Math.imul(h2, 33) ^ c;
    }
  }

  return `\x00${h1 >>> 0}.${h2 >>> 0}`;
}
