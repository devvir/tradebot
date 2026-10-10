/**
 * The transform path a source file needs, decided by the up-front verdict:
 *  - `copy`      already timestamp-sorted and canonical → clean-copy, no work
 *  - `normalize` sorted, but timestamps need normalizing → streaming pass, no sort
 *  - `sort`      not timestamp-sorted → normalize + external sort
 */
export type ResortTier = 'copy' | 'normalize' | 'sort';

/** What actually happened to a file: a tier ran, or the file was skipped. */
export type ResortOutcome = ResortTier | 'skipped';

/** Per-file outcome for the run report. `rows` is null when not counted. */
export interface FileResult {
  file: string;
  tier: ResortOutcome;
  rows: number | null;
}

/**
 * A spawned pipeline stage. `exit` is created the moment the child is spawned —
 * capturing the `close` event even when the process finishes before anyone
 * awaits it (small inputs close stages faster than the pipeline is assembled).
 */
export interface Stage {
  child: import('node:child_process').ChildProcess;
  exit:  Promise<number | null>;
}
