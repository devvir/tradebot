import { Command } from 'commander';
import { run, runLevels, runStage1, runCalibrate } from '../tools/synth/index';
import { error } from '../shared/ui/logger';

/**
 * Register the `synth` command group.
 *
 * Sub-commands:
 *   synth levels    — stream vault orderBookL2 CSV files and write id/symbol/price to MongoDB
 *   synth stage1    — build trade-constrained OB fact log from trade collection
 *   synth calibrate — run calibration analysis Python app (all args passed through)
 *
 * Running `synth` with no sub-command drops into the interactive menu.
 */
export function register(program: Command): void {
  const synth = program
    .command('synth')
    .description('Synthetic data tools')
    .action(async () => {
      try {
        await run(null);
      } catch (err) {
        error((err as Error).message);
        process.exit(1);
      }
    });

  synth
    .command('levels')
    .description('Build orderBookId index from vault orderBookL2 CSV files (crash-safe)')
    .action(async () => {
      try {
        await runLevels();
      } catch (err) {
        error((err as Error).message);
        process.exit(1);
      }
    });

  synth
    .command('stage1')
    .description('Build trade-constrained OB fact log from trade collection (idempotent)')
    .action(async () => {
      try {
        await runStage1();
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
