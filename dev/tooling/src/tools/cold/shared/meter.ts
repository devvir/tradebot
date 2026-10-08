import { C } from '../../../shared/utils/colors';

export const CLEAR = '\x1b[K';

/**
 * Cut a line to the terminal's width, counting what is *visible*.
 *
 * **A wrapped line breaks the block.** Erasing walks up one row per line, so a
 * line the terminal wrapped onto two rows leaves one behind — the same residue
 * the trailing newline caused, from a different direction. Keeping every line
 * inside the width means one line is always one row.
 *
 * Escape sequences occupy no columns, so they are skipped rather than counted;
 * cutting by raw string length would truncate a colour code mid-sequence and
 * spill it onto the screen. A reset is appended when anything is dropped, since
 * the code that would have closed the colour may have been what was cut.
 */
export const fit = (line: string): string => {
  const width = process.stdout.columns ?? 0;

  if (width <= 0) return line;

  let visible = 0;
  let at      = 0;

  while (at < line.length && visible < width) {
    if (line[at] === '\x1b') {
      const end = line.indexOf('m', at);

      if (end < 0) break;

      at = end + 1;

      continue;
    }

    at++;
    visible++;
  }

  return at >= line.length ? line : `${line.slice(0, at)}${C.reset}`;
};

/** A bar filled to a percentage. */
export const meter = (percent: number): string => {
  const filled = Math.max(0, Math.min(WIDTH, Math.round((percent / 100) * WIDTH)));

  return `${C.cyan}${'█'.repeat(filled)}${C.dim}${'░'.repeat(WIDTH - filled)}${C.reset}`;
};

// ── Internals ─────────────────────────────────────────────────────────────────

const WIDTH = 24;
