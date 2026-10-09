import fs from 'node:fs';
import { Progress } from '../shared/progress';
import { follow } from '../shared/progress-mega';
import { transferName } from '../shared/mega';
import { C } from '../../../shared/utils/colors';
import { fmtBytes } from '../../../shared/utils/format';

/**
 * A push, as it is shown: the tar being made and the file Mega is sending,
 * each with how far in it is, and a log line for each thing done.
 *
 * What is drawn is `shared/progress.ts`; what Mega is sending is read by
 * `shared/progress-mega.ts`. What is a push's own is said here: that a tar is
 * being made, read back or corrected, and how many of the run's are stored.
 *
 * One tar is made at a time and Mega sends one file at a time, so the block is
 * at most two lines.
 */
export class PushProgress {
  /** `total` to see through, `done` of them already in cold storage. */
  constructor(private total: number, private done = 0) {
    this.block = new Progress(() => `${this.done}/${this.total} stored`);
  }

  private readonly block: Progress;

  private started = false;
  private making: (() => void) | null = null;
  private shown:  { label: string; bytes: number } | null = null;

  /** Begin following what Mega sends. Idempotent, so a caller need not track whether it started. */
  start(): void {
    if (this.started) return;

    this.started = true;

    follow(this.block, { id: UPLOAD, queue: 'uploads', label: sent => transferName(sent.path), idle: 'nothing uploading', mark: '↑', rank: 1 });
  }

  stop(): void {
    this.block.stop();

    // The block ended without a newline, so without this the shell prompt would resume on the row it occupied.
    if (process.stdout.isTTY) process.stdout.write('\n');
  }

  /** A line for the permanent record. */
  log(line: string): void {
    this.block.log(line);
  }

  /**
   * A tar is being made. `file` is what it is growing into and `bytes` what it
   * will weigh, which is what its line is drawn from; without a file there is
   * only the name.
   */
  working(verb: string, name: string, file: string | null = null, bytes = 0): void {
    this.making?.();

    this.making = this.block.every(MAKING_MS, () => this.block.set(MAKING, { label: `${verb} ${name}`, done: file ? sizeOf(file) : 0, total: file ? bytes : 0, unit: 'bytes' }));
    this.shown  = { label: `${verb} ${name}`, bytes };
  }

  /**
   * The tar is written and is being read back against its source. That can take
   * as long as writing it did, with nothing left to measure — so the bar gives
   * way to the word.
   */
  verifying(): void {
    if (! this.shown) return;

    this.making?.();
    this.making = null;

    this.block.set(MAKING, { label: this.shown.label, done: 0, total: 0, unit: 'bytes', note: `verifying · ${fmtBytes(this.shown.bytes)}` });
  }

  /** The tar is made: its line leaves the block, and `line` joins the log where one is given. */
  worked(line?: string): void {
    this.making?.();

    this.making = null;
    this.shown  = null;

    this.block.set(MAKING, null);

    if (line) this.block.log(line);
  }

  /** The run has more to see through than it started with: what a later look at the catalog found. */
  resize(total: number, done: number): void {
    this.total = total;
    this.done  = done;
  }

  /** Something reached cold storage: one line of the log, counted against the whole run. */
  stored(name: string, bytes: number): void {
    this.done++;

    this.block.log(`Stored ${name} · ${fmtBytes(bytes)} ${C.dim}· ${this.done}/${this.total}${C.reset}`);
  }

}

// ── Internals ─────────────────────────────────────────────────────────────────

/** The block's two lines: what is being made, and what Mega is sending. */
const MAKING = 'making';
const UPLOAD = 'upload';

/** Between redraws while a tar is being made: a small one is done in a second or two. */
const MAKING_MS = 250;

/** How much of a file is there so far; nothing where it does not exist yet. */
const sizeOf = (file: string): number => {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
};
