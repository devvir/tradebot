import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { mongoUri } from '../utils/connect';
import type { MongodumpOptions, MongodumpProgress, MongodumpResult } from './types';

// Re-exported for callers that imported the old name; new code should use `mongoUri` from connect.
export const mongodumpUri = mongoUri;

/**
 * Wrapper around the `mongodump` CLI. One invocation = one (collection, date)
 * pair. Output is a single gzipped archive at `archivePath` containing BSON
 * + metadata for that one collection slice.
 *
 * Progress is parsed from stderr — with `--verbose`, mongodump prints lines like:
 *   `2026-05-23T18:30:00.000+0000	tradebot.quote  91212`
 * (a running document counter, no total). We extract the counter and forward
 * it via `onProgress`; the caller computes pct against its own pre-counted
 * expected total.
 *
 * The final document count comes from the "done dumping `ns` (N documents)"
 * line emitted on completion.
 */

// ── Exports ──────────────────────────────────────────────────────────────────

export async function runMongodump(opts: MongodumpOptions): Promise<MongodumpResult> {
  const args = [
    `--uri=${opts.uri}`,
    `--db=${opts.database}`,
    `--collection=${opts.collection}`,
    `--archive=${opts.archivePath}`,
    '--gzip',
    '--verbose',  // emits running doc-count lines we parse for progress
  ];

  if (opts.query && Object.keys(opts.query).length > 0) {
    args.push(`--query=${JSON.stringify(opts.query)}`);
  }

  const start = Date.now();

  return new Promise<MongodumpResult>((resolve, reject) => {
    const proc = spawn('mongodump', args, { stdio: ['ignore', 'ignore', 'pipe'] });

    let lastDone   = 0;
    let stderrTail = '';
    let buffer     = '';

    proc.stderr!.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-2048);
      buffer    += chunk.toString();

      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const p = parseProgress(line);

        if (p) {
          lastDone = p.done;
          opts.onProgress?.(p);
          continue;
        }

        const done = parseDoneLine(line);

        if (done !== null) lastDone = done;
      }
    });

    proc.on('error', err => reject(new Error(`failed to spawn mongodump: ${err.message}`)));

    proc.on('exit', code => {
      if (code !== 0) {
        reject(new Error(`mongodump exited ${code}: ${stderrTail.trim()}`));
        return;
      }

      let bytes = 0;

      try {
        bytes = fs.statSync(opts.archivePath).size;
      } catch {
        // archive missing — let downstream notice via bytes=0
      }

      resolve({ documents: lastDone, elapsedMs: Date.now() - start, bytes });
    });
  });
}

// ── Internals ────────────────────────────────────────────────────────────────

// Matches a verbose progress line ending in `<ns>  <count>`. The line shape is:
//   `<timestamp>\t<db>.<collection>  <count>`
// We don't bother capturing the namespace — mongodump only dumps one
// collection per invocation, so every progress line is for ours.
const PROGRESS_RE = /\s\S+\.\S+\s+(\d+)\s*$/;
// Anchor on the `(N document[s])` parenthesised count so collection names
// containing digits (e.g. `tradeBin1d`) don't fool a [^\d]-style anchor.
const DONE_RE     = /\((\d+)\s+document/i;

function parseProgress(line: string): MongodumpProgress | null {
  const m = line.match(PROGRESS_RE);

  if (! m) return null;

  return { done: parseInt(m[1], 10) };
}

function parseDoneLine(line: string): number | null {
  const m = line.match(DONE_RE);

  return m ? parseInt(m[1], 10) : null;
}

// ── test exports ─────────────────────────────────────────────────────────────

export const _test_parseProgress = parseProgress;
export const _test_parseDoneLine = parseDoneLine;
