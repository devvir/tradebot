import { info } from '../../shared/ui/logger';
import { C } from '../../shared/utils/colors';
import { fmtBytes } from '../../shared/utils/format';
import * as mega from './mega';

/**
 * A fixed block at the foot of the terminal, with the log scrolling above it.
 *
 * **A run measured in days needs both halves.** The log is the record — what was
 * packed, what was skipped, what failed — and scrolls away as it should. The
 * block is the present tense: which tar Mega is sending, how far in, and how
 * much is behind it. Neither answers the other's question.
 *
 * One bar, because Mega sends one file at a time. Where `db dump` shows a row
 * per concurrent worker, here a second row would only ever be blank.
 *
 * The bar is the **last** line of the block and the counters sit above it. Log
 * lines all carry the same weight, so a bar directly beneath them joins the
 * run rather than ending it; the dim line between separates the two, and the
 * foot of the block is where the eye lands.
 *
 * **It polls rather than being driven.** Packing a two-gigabyte tar is minutes
 * inside a single `await`, and an upload advances the whole time; a block that
 * only redrew when the loop said something would sit frozen through both. The
 * poll is cheap — one `mega-transfers` every few seconds against transfers that
 * take hours.
 *
 * On a non-TTY the block cannot work, so the same information is logged
 * occasionally instead, which keeps a redirected run readable and greppable.
 */
export class Progress {
  constructor(private readonly total: number) {
    this.tty = Boolean(process.stdout.isTTY);
  }

  private readonly tty:  boolean;
  private readonly logs: string[] = [];

  private height  = 0;
  private timer:  NodeJS.Timeout | null = null;
  private snapAt  = 0;

  private done    = 0;
  private failed  = 0;
  private packing: string | null = null;
  private queued  = 0;
  private live:   { name: string; percent: number; bytes: number } | null = null;

  /** Begin polling. Idempotent, so a caller need not track whether it started. */
  start(): void {
    if (this.timer) return;

    this.timer = setInterval(() => { void this.poll(); }, POLL_MS);

    // Nothing here should keep the process alive on its own.
    this.timer.unref();
  }

  /** Clear the block, flush anything pending, and leave the cursor at column 0. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);

    this.timer = null;

    this.erase();
    this.flush();

    // The block ended without a newline, so without this the shell prompt
    // would resume on the row the block occupied.
    if (this.tty) process.stdout.write('\n');
  }

  /**
   * A line for the permanent record.
   *
   * Held rather than printed, so it lands *above* the block on the next redraw
   * instead of through the middle of it.
   */
  log(line: string): void {
    this.logs.push(line);

    if (! this.tty) this.flush();
    else this.redraw();
  }

  packingNow(name: string | null): void {
    this.packing = name;
    this.redraw();
  }

  settled(done: number, failed: number): void {
    this.done   = done;
    this.failed = failed;
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  private async poll(): Promise<void> {
    this.live   = await mega.active();
    this.queued = (await mega.queue()).remaining;

    if (this.tty) this.redraw();
    else this.snapshot();
  }

  private flush(): void {
    for (const line of this.logs) info(line);

    this.logs.length = 0;
  }

  private redraw(): void {
    if (! this.tty) return;

    this.erase();
    this.flush();

    const lines = this.render();

    /**
     * **No newline after the last line**, which is what keeps the block from
     * multiplying down the screen.
     *
     * The block lives at the foot of the terminal, so writing a trailing
     * newline there scrolls it by a row. The cursor stays put on the bottom
     * line, but everything above has shifted up — so the next `cursor up by
     * height` lands a row too low, erases the wrong rows, and leaves the old
     * block behind. Once per poll, for ever.
     *
     * Ending on the last line instead means nothing scrolls and the cursor is
     * always a known distance from the top of the block.
     */
    process.stdout.write(lines.map(line => `${CLEAR}${fit(line)}`).join('\n'));

    this.height = lines.length;
  }

  /**
   * Blank the block and leave the cursor where its first line began.
   *
   * The cursor sits at the **end of the last line**, since that is where
   * drawing left it. So this clears that line, then steps up one row at a time
   * clearing each — ending at column zero of the row the block started on,
   * ready for whatever is written next.
   *
   * Every step is a movement the terminal already has room for: nothing is
   * written past the last line, so nothing scrolls and the arithmetic cannot
   * drift.
   */
  private erase(): void {
    if (! this.tty || this.height === 0) return;

    process.stdout.write(`\r${CLEAR}`);

    for (let above = 1; above < this.height; above++) process.stdout.write(`\x1b[1A\r${CLEAR}`);

    this.height = 0;
  }

  private render(): string[] {
    const bar = this.live
      ? `${C.cyan}↑${C.reset} ${this.live.name}  ${meter(this.live.percent)} `
        + `${this.live.percent.toFixed(1).padStart(5)}% of ${fmtBytes(this.live.bytes)}`
      : `${C.dim}↑ nothing uploading${C.reset}`;

    const state = [
      `${this.done}/${this.total} parts sent`,
      this.failed > 0 ? `${this.failed} failed` : null,
      `${fmtBytes(this.queued)} queued`,
      this.packing ? `packing ${this.packing}` : null,
    ].filter(Boolean).join('  ·  ');

    /**
     * The bar goes **last**, with the dim counters between it and the log.
     *
     * Everything above is log lines in the same weight, one after another, so a
     * bar sitting immediately under them reads as one more of them. Putting the
     * quiet line in between breaks the run, and the foot of the block is the
     * one place the eye returns to.
     */
    return [`${C.dim}  ${state}${C.reset}`, bar];
  }

  /** The same facts as one line, for output that cannot hold a block still. */
  private snapshot(): void {
    const now = Date.now();

    if (now - this.snapAt < SNAPSHOT_MS) return;

    this.snapAt = now;

    info(`${this.done}/${this.total} parts sent · ${fmtBytes(this.queued)} queued`
      + (this.live ? ` · uploading ${this.live.name} ${this.live.percent.toFixed(1)}%` : '')
      + (this.packing ? ` · packing ${this.packing}` : ''));
  }
}

/** Between polls. Transfers take hours, so this is already far finer than needed. */
const POLL_MS = 3_000;

/** Between snapshots when the block cannot be drawn. */
const SNAPSHOT_MS = 30_000;

const CLEAR = '\x1b[K';
const WIDTH = 24;

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
const fit = (line: string): string => {
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

const meter = (percent: number): string => {
  const filled = Math.max(0, Math.min(WIDTH, Math.round((percent / 100) * WIDTH)));

  return `${C.cyan}${'█'.repeat(filled)}${C.dim}${'░'.repeat(WIDTH - filled)}${C.reset}`;
};

