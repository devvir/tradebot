import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import readline from 'node:readline';
import { once } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import { error, info, section, success, warn } from '../../../shared/ui/logger';
import type { LineCursor, PairFile } from './types';

/**
 * ONE-TIME: merge the pool-segregated legacy quote sources —
 * `<day>.primary.csv.gz` + `<day>.secondary.csv.gz` → `<day>.merged.csv.gz` —
 * for the pooled REST era (quote 2026-04-14 → 2026-07-13), producing the
 * make-believe pool-tagged S3 bucket: symbol-major, pools interleaved in time
 * within each symbol block, `pool` column appended (the vault header form).
 * Delete this tool once the legacy pairs are merged and validated.
 *
 * Matches ONLY days having BOTH `.primary` and `.secondary` files — nothing
 * else in the folder (`.s3`, `.rest`, bare buckets) is ever touched, so it can
 * run in place. Days with an existing output are skipped (idempotent). The
 * originals are read-only; output goes to `.tmp` and is renamed only after the
 * row-count invariant (`out == primary + secondary`) is verified by reading the
 * finished artifact back (which also proves gzip integrity).
 *
 * Merge walk (preconditions verified on all real pairs 2026-07-16: uniform
 * headers, every symbol one contiguous block, secondary symbols ⊆ primary's,
 * same relative block order — scribe's stable registry order):
 *   - shared symbol block → two-pointer merge by `timestamp`, Primary first on
 *     ties, then drain whichever source still has rows for that symbol;
 *   - differing symbols → primary-only block, streamed through (secondary's
 *     current block always comes later in primary's order);
 *   - secondary rows left after primary ends → precondition violation → abort
 *     the day (its `.tmp` is removed, sources untouched).
 */
export async function runMergePools(root: string): Promise<void> {
  const pairs = discoverPairs(root);

  if (pairs.length === 0) {
    warn('No <day>.primary + <day>.secondary pairs found (or all already merged).');

    return;
  }

  section(`Merge pools — ${pairs.length} day pair(s)`);

  let ok = 0;

  for (const pair of pairs) {
    await mergePair(pair);
    ok++;
  }

  success(`Merged ${ok} day(s). Originals untouched — validate, then trash the .primary/.secondary files.`);
}

// ── Per-pair merge ────────────────────────────────────────────────────────────

async function mergePair(pair: PairFile): Promise<void> {
  const tmp = pair.outPath + '.tmp';

  try {
    const p = await openCursor(pair.primaryPath);
    const s = await openCursor(pair.secondaryPath);

    const headerP = p.peek;
    const headerS = s.peek;

    if (headerP === null || headerP !== headerS) {
      throw new Error(`header mismatch between primary and secondary (${headerP} vs ${headerS})`);
    }

    await p.next();
    await s.next();

    const outFd = fs.openSync(tmp, 'w');
    const pigz  = spawn('pigz', ['-p4'], { stdio: ['pipe', outFd, 'inherit'] });
    const exit  = new Promise<number | null>(resolve => {
      pigz.once('error', () => resolve(null));
      pigz.once('close', code => resolve(code));
    });

    const out = createWriter(pigz);

    await out.write(`${headerP},pool\n`);

    let pRows = 0;
    let sRows = 0;

    while (p.peek !== null && s.peek !== null) {
      if (p.sym !== s.sym) {
        // Primary-only block — secondary's current block comes later in
        // primary's (shared, verified) symbol order.
        await out.write(`${p.peek},Primary\n`);
        pRows++;
        await p.next();
        continue;
      }

      // Shared block: two-pointer timestamp merge, Primary first on ties,
      // then drain whichever source still has rows for this symbol.
      const sym = p.sym;

      while (p.peek !== null && p.sym === sym && s.peek !== null && s.sym === sym) {
        if (p.ts <= s.ts) {
          await out.write(`${p.peek},Primary\n`);
          pRows++;
          await p.next();
        } else {
          await out.write(`${s.peek},Secondary\n`);
          sRows++;
          await s.next();
        }
      }

      while (s.peek !== null && s.sym === sym) {
        await out.write(`${s.peek},Secondary\n`);
        sRows++;
        await s.next();
      }

      while (p.peek !== null && p.sym === sym) {
        await out.write(`${p.peek},Primary\n`);
        pRows++;
        await p.next();
      }
    }

    while (p.peek !== null) {
      await out.write(`${p.peek},Primary\n`);
      pRows++;
      await p.next();
    }

    if (s.peek !== null) {
      throw new Error(
        `secondary has symbol '${s.sym}' with no primary block — violated precondition (secondary ⊆ primary)`,
      );
    }

    await out.end();

    const code = await exit;

    fs.closeSync(outFd);

    if (code !== 0) throw new Error(`pigz exited with code ${code}`);

    await verifyRowCount(tmp, pRows + sRows);

    fs.renameSync(tmp, pair.outPath);

    info(`${pair.day}  primary ${pRows.toLocaleString()} + secondary ${sRows.toLocaleString()} → ${(pRows + sRows).toLocaleString()} rows`);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* best effort */ }

    error(`${pair.day}: ${(err as Error).message}`);

    throw err;
  }
}

// ── Pair discovery ────────────────────────────────────────────────────────────

const PRIMARY_RE = /^(\d{8})\.primary\.csv\.gz$/;

/**
 * Days in `root` having BOTH `.primary` and `.secondary` files and no merge
 * output yet. Primary-only or secondary-only days are reported and skipped.
 */
function discoverPairs(root: string): PairFile[] {
  const names = new Set(fs.readdirSync(root));
  const pairs: PairFile[] = [];

  for (const name of [...names].sort()) {
    const m = PRIMARY_RE.exec(name);

    if (! m) continue;

    const day       = m[1]!;
    const secondary = `${day}.secondary.csv.gz`;
    const output    = `${day}.merged.csv.gz`;

    if (! names.has(secondary)) {
      warn(`${day}: primary without secondary — skipped`);
      continue;
    }

    if (names.has(output)) continue;   // already merged

    pairs.push({
      day,
      primaryPath:   path.join(root, name),
      secondaryPath: path.join(root, secondary),
      outPath:       path.join(root, output),
    });
  }

  return pairs;
}

// ── I/O helpers ───────────────────────────────────────────────────────────────

/** Pull-based line cursor over a gzipped CSV; `sym`/`ts` parsed per line. */
async function openCursor(file: string): Promise<LineCursor> {
  const stream = fs.createReadStream(file).pipe(zlib.createGunzip());
  const rl     = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const it     = rl[Symbol.asyncIterator]();

  const cursor: LineCursor = {
    peek: null,
    sym:  '',
    ts:   '',

    async next(): Promise<void> {
      const { value, done } = await it.next();

      if (done || value === undefined) {
        cursor.peek = null;
        cursor.sym  = '';
        cursor.ts   = '';

        return;
      }

      const c1 = value.indexOf(',');
      const c2 = value.indexOf(',', c1 + 1);

      cursor.peek = value;
      cursor.ts   = value.slice(0, c1);
      cursor.sym  = value.slice(c1 + 1, c2);
    },
  };

  await cursor.next();   // position on the header line

  return cursor;
}

/** Buffered writer into pigz stdin: batches lines, honors backpressure. */
function createWriter(pigz: ChildProcess) {
  const FLUSH_AT = 1 << 16;   // 64 KiB
  let   buf      = '';

  const flush = async (): Promise<void> => {
    if (buf.length === 0) return;

    const chunk = buf;

    buf = '';

    if (! pigz.stdin!.write(chunk)) await once(pigz.stdin!, 'drain');
  };

  return {
    async write(line: string): Promise<void> {
      buf += line;

      if (buf.length >= FLUSH_AT) await flush();
    },

    async end(): Promise<void> {
      await flush();
      pigz.stdin!.end();
    },
  };
}

/**
 * Read the finished artifact back: total lines must equal header + expected
 * rows. Full decompression also proves gzip integrity.
 */
async function verifyRowCount(file: string, expectedRows: number): Promise<void> {
  const stream = fs.createReadStream(file).pipe(zlib.createGunzip());
  const rl     = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let lines = 0;

  for await (const _ of rl) lines++;

  if (lines !== expectedRows + 1) {
    throw new Error(`row-count mismatch: output has ${lines - 1} data rows, expected ${expectedRows}`);
  }
}
