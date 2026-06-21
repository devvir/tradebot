import { info } from '../../../shared/ui/logger';
import { C } from '../../../shared/utils/colors';
import { fmtCount, fmtElapsed } from './format';
import type { PlanRow } from '../types';
import type { ActiveEntry } from '../types';

const CLEAR_LINE       = '\x1b[K';
const REDRAW_MS        = 250;     // coalesce updates: redraw at most 4×/sec
const LABEL_WIDTH      = 36;      // truncated/padded collection [period] label
const NONTTY_SNAP_MS   = 30_000;  // non-TTY: emit a progress snapshot at most every 30s

/**
 * In-place multi-line progress block at the bottom of the terminal.
 *
 *   Permanent log lines (start/done/fail) flow above the block.
 *   The block itself stays fixed: one header showing aggregate progress,
 *   one row per active concurrent worker with its own %.
 *
 * Redraws are throttled to ~4/sec to avoid flicker under heavy progress
 * events. On non-TTY stdout (a pipe — e.g. `| tee` — or a `>` redirect) the
 * in-place block can't work, so instead a plain per-active-worker progress
 * snapshot is logged at most every `NONTTY_SNAP_MS`, keeping a long redirected
 * run observable (and greppable) without the bottom block.
 */
export class ProgressBlock {
  private active           = new Map<string, ActiveEntry>();
  private completed        = 0;
  private failed           = 0;
  private readonly total:    number;
  private readonly start:    number;
  private readonly isTty:    boolean;
  private blockHeight      = 0;
  private pending          = false;
  private timer:           NodeJS.Timeout | null = null;
  private pendingLogs:     string[] = [];
  private lastSnapshot     = 0;

  constructor(total: number) {
    this.total = total;
    this.start = Date.now();
    this.isTty = Boolean(process.stdout.isTTY);
  }

  pairStart(key: string, idx: number, row: PlanRow): void {
    this.active.set(key, { idx, row, done: 0, start: Date.now() });
    this.scheduleRedraw();
  }

  pairUpdate(key: string, done: number): void {
    const e = this.active.get(key);

    if (e) {
      e.done = done;
      this.scheduleRedraw();
    }
  }

  pairDone(key: string, line: string): void {
    this.active.delete(key);
    this.completed++;
    this.pendingLogs.push(line);
    this.scheduleRedraw();
  }

  pairFail(key: string, line: string): void {
    this.active.delete(key);
    this.failed++;
    this.pendingLogs.push(line);
    this.scheduleRedraw();
  }

  /** Final flush: clear block, emit any pending logs, leave terminal at column 0. */
  stop(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }

    this.clearBlock();

    for (const line of this.pendingLogs) info(line);

    this.pendingLogs = [];
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private scheduleRedraw(): void {
    if (this.pending) return;

    this.pending = true;
    this.timer   = setTimeout(() => {
      this.pending = false;
      this.timer   = null;
      this.redraw();
    }, REDRAW_MS);
  }

  private redraw(): void {
    if (! this.isTty) {
      // Non-TTY: flush completion lines, then (throttled) a plain progress
      // snapshot of each active worker so a piped/redirected run stays visible.
      for (const line of this.pendingLogs) info(line);

      this.pendingLogs = [];

      const now = Date.now();

      if (this.active.size > 0 && now - this.lastSnapshot >= NONTTY_SNAP_MS) {
        this.lastSnapshot = now;

        for (const e of Array.from(this.active.values()).sort((a, b) => a.idx - b.idx)) {
          info(this.renderActivePlain(e));
        }
      }

      return;
    }

    this.clearBlock();

    for (const line of this.pendingLogs) info(line);

    this.pendingLogs = [];

    const lines = this.renderBlock();

    for (const line of lines) process.stdout.write(line + '\n');

    this.blockHeight = lines.length;
  }

  private clearBlock(): void {
    if (! this.isTty || this.blockHeight === 0) return;

    process.stdout.write(`\x1b[${this.blockHeight}A`);

    for (let i = 0; i < this.blockHeight; i++) {
      process.stdout.write(`${CLEAR_LINE}\n`);
    }

    process.stdout.write(`\x1b[${this.blockHeight}A`);
    this.blockHeight = 0;
  }

  private renderBlock(): string[] {
    const elapsed = fmtElapsed((Date.now() - this.start) / 1000);
    const okPart  = `${this.completed}/${this.total} done`;
    const failPart = this.failed > 0 ? `, ${C.yellow}${this.failed} failed${C.reset}` : '';
    const header  = `${C.bold}[${okPart}${failPart}, ${this.active.size} active] · elapsed ${elapsed}${C.reset}`;

    const rows = Array.from(this.active.values())
      .sort((a, b) => a.idx - b.idx)
      .map(e => this.renderActive(e));

    return [header, ...rows];
  }

  /**
   * Rough ETA for one active worker: linear extrapolation from elapsed/%.
   * `ETA —` until ≥1% so the first estimate isn't wildly off. Shared by both
   * the TTY row and the non-TTY snapshot so they never drift apart.
   */
  private etaStr(e: ActiveEntry, pct: number): string {
    if (pct < 1) return 'ETA —';

    const elapsed = (Date.now() - e.start) / 1000;

    return `~${fmtElapsed(elapsed / pct * (100 - pct))} left`;
  }

  /** Plain (no ANSI) one-line progress for non-TTY snapshots: static bar + %, counts and rough ETA. */
  private renderActivePlain(e: ActiveEntry): string {
    const period  = e.row.periodLabel ?? e.row.date?.label ?? 'all';
    const pct     = e.row.count > 0 ? Math.min(100, e.done / e.row.count * 100) : 0;
    const elapsed = (Date.now() - e.start) / 1000;
    const idxStr  = (e.idx + 1).toString().padStart(String(this.total).length);
    const filled  = Math.round(pct / 100 * 20);
    const bar     = '█'.repeat(filled) + '░'.repeat(20 - filled);

    return `  [${idxStr}/${this.total}] ${e.row.collection} [${period}]  ${bar} ${pct.toFixed(1).padStart(5)}%  `
      + `${fmtCount(e.done)} / ${fmtCount(e.row.count)}  · ${fmtElapsed(elapsed)} elapsed, ${this.etaStr(e, pct)}`;
  }

  private renderActive(e: ActiveEntry): string {
    const period  = e.row.periodLabel ?? e.row.date?.label ?? 'all';
    const label   = padOrTruncate(`${e.row.collection} [${period}]`, LABEL_WIDTH);
    const pct     = e.row.count > 0 ? Math.min(100, e.done / e.row.count * 100) : 0;
    const pctStr  = `${pct.toFixed(1).padStart(5)}%`;
    const bar     = renderBar(pct, 20);
    const counts  = `${fmtCount(e.done).padStart(6)} / ${fmtCount(e.row.count).padStart(6)}`;
    const elapsed = fmtElapsed((Date.now() - e.start) / 1000).padStart(6);
    const idxStr  = (e.idx + 1).toString().padStart(String(this.total).length);

    return `  ${C.dim}[${idxStr}/${this.total}]${C.reset} ${label} ${bar} ${pctStr}  ${counts}  ${C.dim}${elapsed}${C.reset}  ${C.dim}${this.etaStr(e, pct)}${C.reset}`;
  }
}

function padOrTruncate(s: string, width: number): string {
  if (s.length === width) return s;
  if (s.length <  width)  return s.padEnd(width);

  return s.slice(0, width - 1) + '…';
}

function renderBar(pct: number, width: number): string {
  const filled = Math.round((pct / 100) * width);
  const empty  = width - filled;

  return `${C.cyan}${'█'.repeat(filled)}${C.dim}${'░'.repeat(empty)}${C.reset}`;
}
