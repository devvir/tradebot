import { spawn } from 'node:child_process';
import path from 'node:path';
import { error, info, success } from '../log';
import { concurrency, fromDay, isDryRun, logPath } from '../options';

/**
 * Concurrency mode (`-C >= 2`) entry point. Spawns one `tools sources prepare`
 * subprocess per date, with exactly C children running at any time. Each free
 * slot picks the next pending date — no pre-distribution.
 */
export async function runOrchestrator(files: string[]): Promise<void> {
  const C = concurrency();

  /**
   * One task per date. Bucket filenames must start with `YYYYMMDD`, so the
   * dir + first 8 chars of the basename uniquely identify the date. Merged-day
   * siblings (e.g. `20260410.local.csv.gz` + `20260410.mtav.csv.gz`) collapse
   * to a single `…/20260410` prefix; the subprocess re-discovers all sources
   * for that date and merges them in its own `discoverGroups` pass.
   */
  const tasks = [...new Set(
    files.map(f => path.join(path.dirname(f), path.basename(f).slice(0, 8))),
  )];

  info(`Spawning ${C} workers for ${tasks.length} buckets`);

  const queue: string[] = [...tasks];

  let inFlight  = 0;
  let processed = 0;
  let failed    = 0;

  await new Promise<void>((resolve) => {
    const dispatch = (): void => {
      while (queue.length > 0 && inFlight < C) {
        const file = queue.shift()!;

        inFlight++;

        launch(file).then(ok => {
          inFlight--;

          if (ok) processed++;
          else    failed++;

          if (queue.length === 0 && inFlight === 0) {
            resolve();

            return;
          }

          dispatch();
        });
      }

      if (queue.length === 0 && inFlight === 0) resolve();
    };

    dispatch();
  });

  if (failed > 0) {
    error(`Done. Processed: ${processed}. Failed: ${failed}.`);
    process.exit(1);
  } else {
    success(`Done. Processed: ${processed}.`);
  }
}

// ── Child invocation ─────────────────────────────────────────────────────────

function launch(file: string): Promise<boolean> {
  const baseLog = logPath();
  const baseDir = baseLog ? path.dirname(baseLog) : null;

  const args: string[] = ['sources'];

  if (isDryRun()) args.push('-D');
  if (fromDay())  args.push('--from', fromDay()!);
  if (baseDir)    args.push('--log', baseDir);

  args.push('prepare', file);

  return new Promise<boolean>((resolve) => {
    const child = spawn(process.argv[0]!, [process.argv[1]!, ...args], {
      stdio: 'inherit',
      env:   process.env,
    });

    child.on('exit', code => resolve(code === 0));
  });
}
