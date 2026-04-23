import { selectFromList } from '../../shared/ui/prompts';
import type { SynthSubcommand } from './types';
import { runLevels } from './levels';
import { runStage1 } from './stage1';
import { runCalibrate } from './calibrate';

export { runLevels, runStage1, runCalibrate };

export async function run(cliSubcommand: SynthSubcommand | null): Promise<void> {
  const subcommand = cliSubcommand ?? await promptSubcommand();

  if (subcommand === 'levels') {
    await runLevels();
  } else if (subcommand === 'stage1') {
    await runStage1();
  } else if (subcommand === 'calibrate') {
    await runCalibrate([]);
  }
}

async function promptSubcommand(): Promise<SynthSubcommand> {
  return (
    (await selectFromList<SynthSubcommand>(
      [
        { name: 'Levels    — build orderBookId lookup from vault orderBookL2 files', value: 'levels' },
        { name: 'Stage1    — build trade-constrained OB fact log from trade collection', value: 'stage1' },
        { name: 'Calibrate — run calibration analysis (Python)', value: 'calibrate' },
      ],
      'Select operation:',
    )) ?? 'levels'
  );
}
