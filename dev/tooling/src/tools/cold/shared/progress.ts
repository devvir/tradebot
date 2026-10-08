import fs from 'node:fs';
import { info } from '../../../shared/ui/logger';
import { C } from '../../../shared/utils/colors';
import { fmtBytes } from '../../../shared/utils/format';
import * as mega from './mega';
import { CLEAR, fit, meter } from './meter';

/**
 * A fixed block at the foot of the terminal, with the log scrolling above it.
 *
 * **A run measured in days needs both halves.** The log is the record — what was
 * packed, what was stored, what failed — and scrolls away as it should. The
 * block is the present tense: the tar being packed and the tar Mega is sending,
 * each with how far in it is. Neither answers the other's question.
 *
 * **A line per thing in progress, and a log line when it is done.** One tar is
 * packed at a time and Mega sends one file at a time, so the block is at most
 * two bars. A tar that finishes either leaves the block and becomes one line
 * of the log — so the log says only what was done, never what was begun.
 *
 * **It polls rather than being driven.** Packing a two-gigabyte tar is minutes
 * inside a single `await`, and an upload advances the whole time; a block that
 * only redrew when the loop said something would sit frozen through both. The
 * upload is one `mega-transfers` every few seconds against transfers that take
 * hours; the tar being packed is a `stat` of the file it is growing into.
 *
 * On a non-TTY the block cannot work, so the same information is logged
 * occasionally instead, which keeps a redirected run readable and greppable.
 */
export class Progress {
  /** `total` tars to see through, `done` of them already in cold storage. */
  constructor(private total: number, private done = 0) {
    this.tty = Boolean(process.stdout.isTTY);
  }

  private readonly tty:  boolean;
  private readonly logs: string[] = [];

  private height  = 0;
  private timer:  NodeJS.Timeout | null = null;
  private fast:   NodeJS.Timeout | null = null;
  private snapAt  = 0;

  private packing: { verb: string; name: string; file: string | null; bytes: number; verifying: boolean } | null = null;
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
    if (this.fast)  clearInterval(this.fast);

    this.timer = null;
    this.fast  = null;

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

  /**
   * A tar is being made. `file` is what it is growing into and `bytes` what it
   * will weigh, which is what the bar is drawn from; without a file there is no
   * bar, only the name.
   */
  working(verb: string, name: string, file: string | null = null, bytes = 0): void {
    this.packing = { verb, name, file, bytes, verifying: false };

    if (this.tty && ! this.fast) {
      this.fast = setInterval(() => this.redraw(), PACK_MS);
      this.fast.unref();
    }

    this.redraw();
  }

  /**
   * The tar is written and is being read back against its source. That can take
   * as long as writing it did, with nothing left to measure — so the bar gives
   * way to the word.
   */
  verifying(): void {
    if (this.packing) this.packing.verifying = true;

    this.redraw();
  }

  /** The tar is made: its line leaves the block, and `line` joins the log where one is given. */
  worked(line?: string): void {
    this.packing = null;

    if (this.fast) clearInterval(this.fast);

    this.fast = null;

    if (line) this.log(line);
    else this.redraw();
  }

  /** The run has more to see through than it started with: what a later look at the catalog found. */
  resize(total: number, done: number): void {
    this.total = total;
    this.done  = done;
  }

  /** A tar reached cold storage: one line of the log, counted against the whole run. */
  stored(name: string, bytes: number): void {
    this.done++;

    this.log(`Stored ${name} · ${fmtBytes(bytes)} ${C.dim}· ${this.done}/${this.total}${C.reset}`);
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  private async poll(): Promise<void> {
    this.live = await mega.active();

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

  /** What is in progress, a line each; the upload last, since it is the one that is always there. */
  private render(): string[] {
    const lines: string[] = [];

    if (this.packing) {
      const { verb, name, file, bytes, verifying } = this.packing;
      const percent = file && bytes > 0 && ! verifying ? Math.min(100, (sizeOf(file) / bytes) * 100) : null;

      lines.push(percent === null
        ? `${C.cyan}▪${C.reset} ${verb} ${name}${verifying ? `  ${C.dim}verifying · ${fmtBytes(bytes)}${C.reset}` : ''}`
        : `${C.cyan}▪${C.reset} ${verb} ${name}  ${meter(percent)} `
          + `${percent.toFixed(1).padStart(5)}% of ${fmtBytes(bytes)}`);
    }

    lines.push(this.live
      ? `${C.cyan}↑${C.reset} ${this.live.name}  ${meter(this.live.percent)} `
        + `${this.live.percent.toFixed(1).padStart(5)}% of ${fmtBytes(this.live.bytes)}`
      : `${C.dim}↑ nothing uploading${C.reset}`);

    return lines;
  }

  /** The same facts as one line, for output that cannot hold a block still. */
  private snapshot(): void {
    const now = Date.now();

    if (now - this.snapAt < SNAPSHOT_MS) return;

    this.snapAt = now;

    info(`${this.done}/${this.total} tars stored`
      + (this.live ? ` · uploading ${this.live.name} ${this.live.percent.toFixed(1)}%` : '')
      + (this.packing ? ` · ${this.packing.verifying ? 'verifying' : this.packing.verb.toLowerCase()} ${this.packing.name}` : ''));
  }
}

// ── Internals ─────────────────────────────────────────────────────────────────

/** Between polls. Transfers take hours, so this is already far finer than needed. */
const POLL_MS = 3_000;

/** Between redraws while a tar is being made: a small one is done in a second or two. */
const PACK_MS = 250;

/** Between snapshots when the block cannot be drawn. */
const SNAPSHOT_MS = 30_000;

/** How much of a file is there so far; nothing where it does not exist yet. */
const sizeOf = (file: string): number => {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
};
