import { selectFromList, input } from '../../shared/ui/prompts';
import { setDryRun, setFromDay, setLogPath } from './options';
import { runPrepare } from './prepare/run';
import { runCheck } from './check/run';

// ── Subcommand registry ───────────────────────────────────────────────────────

type Subcommand = 'prepare' | 'check';

const subcommands: { name: string; value: Subcommand }[] = [
  { name: 'Prepare — sort, dedup, gap-fill (merge) WS source files', value: 'prepare' },
  { name: 'Check   — verify .csv.gz integrity; recover corrupt files', value: 'check'   },
];

// ── Entry point ───────────────────────────────────────────────────────────────

const DEFAULT_VAULT_DIR = '/data/bitmex/vault';

export async function run(): Promise<void> {
  const choice = (await selectFromList<Subcommand>(subcommands, 'Select operation:')) ?? 'prepare';
  const root   = (await input('Path:', process.env['VAULT_DATA_DIR'] ?? DEFAULT_VAULT_DIR)) || (process.env['VAULT_DATA_DIR'] ?? DEFAULT_VAULT_DIR);

  setDryRun(false);
  setFromDay(null);
  setLogPath(null);

  if (choice === 'prepare') {
    await runPrepare(root);
  }

  if (choice === 'check') {
    await runCheck(root);
  }
}
