import { info } from '../../../shared/ui/logger';
import { C } from '../../../shared/utils/colors';
import { fmtBytes } from '../../../shared/utils/format';
import { CLEAR, fit, meter } from './meter';
import type { Bar } from './types';

/**
 * A fixed block at the foot of the terminal, with the log scrolling above it.
 *
 * **A long run needs both halves.** The log is the record — what was done, what
 * failed — and scrolls away as it should. The block is the present tense: each
 * thing under way, with how far in it is. Neither answers the other's question.
 *
 * **It draws, and knows nothing of what it draws.** A line is a `Bar` it is
 * handed: a name, how much of how much, and what that counts. Where the numbers
 * come from — a queue of Mega's, a file growing on disk, a loop counting what
 * it has done — is whoever hands them over. So how progress looks is changed
 * here and nowhere else, and a new thing to follow is a new source and nothing
 * here.
 *
 * **A line per thing under way, and a log line when it is done.** A line is set
 * while its thing goes on and taken away when it ends; what is worth keeping of
 * it is said to the log.
 *
 * On a non-TTY the block cannot work, so the same lines are logged now and
 * then instead, which keeps a redirected run readable and greppable.
 */
export class Progress {
  /** `headline` opens the line logged where the block cannot be drawn: how the run as a whole stands. */
  constructor(private readonly headline: () => string = () => '') {
    this.tty = Boolean(process.stdout.isTTY);
  }

  private readonly tty:    boolean;
  private readonly logs:   { line: string; say: (line: string) => void }[] = [];
  private readonly bars    = new Map<string, Bar>();
  private readonly timers  = new Set<NodeJS.Timeout>();

  private height = 0;
  private snapAt = 0;

  /** Take the block down, say anything held back, and leave the cursor at column 0 of where it was. */
  stop(): void {
    if (shown === this) shown = null;

    for (const timer of this.timers) clearInterval(timer);

    this.timers.clear();
    this.bars.clear();

    this.erase();
    this.flush();
  }

  /**
   * A line for the permanent record.
   *
   * Held rather than printed, so it lands *above* the block on the next redraw
   * instead of through the middle of it.
   */
  log(line: string, say: (line: string) => void = info): void {
    this.logs.push({ line, say });

    if (! this.tty) this.flush();
    else this.redraw();
  }

  /** Set a line of the block, or take it away. Lines are drawn by rank, and within one in the order they were first set. */
  set(id: string, bar: Bar | null): void {
    shown = this;

    if (bar) this.bars.set(id, bar);
    else this.bars.delete(id);

    if (this.tty) this.redraw();
    else this.snapshot();
  }

  /**
   * Run something at intervals for as long as the block is up: how a source
   * keeps its line current. Returns what stops it sooner.
   *
   * **Never two at once**: a look that has not come back is not followed by
   * another, so a source that is slow to answer is asked no more often than it
   * answers.
   */
  every(ms: number, look: () => void | Promise<void>): () => void {
    let busy = false;

    const tick = async (): Promise<void> => {
      if (busy) return;

      busy = true;

      try {
        await look();
      } catch {
        // A look that failed is taken again at the next interval.
      } finally {
        busy = false;
      }
    };

    const timer = setInterval(() => { void tick(); }, ms);

    // Nothing here should keep the process alive on its own.
    timer.unref();

    this.timers.add(timer);

    void tick();

    return () => {
      clearInterval(timer);

      this.timers.delete(timer);
    };
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  private flush(): void {
    for (const { line, say } of this.logs) say(line);

    this.logs.length = 0;
  }

  private redraw(): void {
    if (! this.tty) return;

    this.erase();
    this.flush();

    const lines = this.ranked().map(lineOf);

    /**
     * **No newline after the last line**, which is what keeps the block from
     * multiplying down the screen.
     *
     * The block lives at the foot of the terminal, so writing a trailing
     * newline there scrolls it by a row. The cursor stays put on the bottom
     * line, but everything above has shifted up — so the next `cursor up by
     * height` lands a row too low, erases the wrong rows, and leaves the old
     * block behind. Once per redraw, for ever.
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

  /** The lines, in the order they are drawn in. */
  private ranked(): Bar[] {
    return [...this.bars.values()].sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
  }

  /** The same facts as one line, for output that cannot hold a block still. */
  private snapshot(): void {
    const now = Date.now();

    if (now - this.snapAt < SNAPSHOT_MS) return;

    const said = [this.headline(), ...this.ranked().filter(bar => ! bar.quiet).map(plainOf)].filter(part => part !== '');

    if (said.length === 0) return;

    this.snapAt = now;

    info(said.join(' · '));
  }
}

/**
 * Say a line from somewhere that does not know whether a block is up: above
 * the block where one is, and as it would be said otherwise where none is. A
 * line written straight to the terminal lands in the middle of a block, and
 * leaves a copy of it behind.
 */
export const above = (line: string, say: (line: string) => void = info): void => {
  if (shown) shown.log(line, say);
  else say(line);
};

// ── Internals ─────────────────────────────────────────────────────────────────

/** The block that is up, where one is. */
let shown: Progress | null = null;

/** Between snapshots when the block cannot be drawn. */
const SNAPSHOT_MS = 30_000;

const percentOf = (bar: Bar): number => (bar.total > 0 ? Math.min(100, (bar.done / bar.total) * 100) : 0);

/** How far along a bar is, in words: a share of bytes, or so many of so many. */
const amountOf = (bar: Bar): string => (bar.unit === 'bytes'
  ? `${percentOf(bar).toFixed(1).padStart(5)}% of ${fmtBytes(bar.total)}`
  : `${bar.done.toLocaleString('en-US')}/${bar.total.toLocaleString('en-US')}${bar.of ? ` ${bar.of}` : ''}`);

/** A bar as a line of the block. */
const lineOf = (bar: Bar): string => {
  const mark = bar.mark ?? '▪';

  if (bar.quiet) return `${C.dim}${mark} ${bar.label}${C.reset}`;

  const head = `${C.cyan}${mark}${C.reset} ${bar.label}`;

  if (bar.note !== undefined) return `${head}  ${C.dim}${bar.note}${C.reset}`;

  return bar.total > 0 ? `${head}  ${meter(percentOf(bar))} ${amountOf(bar)}` : head;
};

/** A bar as part of a line of the log. */
const plainOf = (bar: Bar): string =>
  `${bar.label}${bar.note !== undefined ? ` ${bar.note}` : bar.total > 0 ? ` ${amountOf(bar).trim()}` : ''}`;
