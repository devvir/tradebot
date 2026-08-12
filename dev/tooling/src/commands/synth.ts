import { Command } from 'commander';
import { runCalibrate } from '../tools/synth/calibrate';
import { error } from '../shared/ui/logger';

/**
 * Register the `synth` command group.
 *
 * Calibration is all that is left here. `levels` and `stage1` built their
 * output into MongoDB — one an orderBookId index read from vault CSVs, the
 * other a trade-constrained fact log — and went with it when the database did.
 *
 * What remains is a passthrough to the Python app under `scripts/calibrate/`,
 * which reads and writes files and never needed a database. `synth` with no
 * sub-command runs it, since there is no longer a choice to offer.
 */
export function register(program: Command): void {
  const synth = program
    .command('synth')
    .description('Synthetic data tools')
    .action(async () => {
      try {
        await runCalibrate([]);
      } catch (err) {
        error((err as Error).message);
        process.exit(1);
      }
    });

  synth
    .command('calibrate')
    .description('Run calibration analysis Python app (all arguments passed through)')
    .allowUnknownOption(true)
    .action(async () => {
      const idx = process.argv.indexOf('calibrate');
      const args = idx >= 0 ? process.argv.slice(idx + 1) : [];

      try {
        await runCalibrate(args);
      } catch (err) {
        error((err as Error).message);
        process.exit(1);
      }
    });
}
