import { selectFromList, input } from '../../shared/ui/prompts';
import { setDryRun, setFromDay, setLogPath, setYes } from './options';
import { runPrepare } from './prepare/run';
import { runCheck } from './check/run';
import { runStatus } from './status/run';
import { runUpdate } from './update/run';

// ── Subcommand registry ───────────────────────────────────────────────────────

type Subcommand = 'prepare' | 'check' | 'status' | 'update';

const subcommands: { name: string; value: Subcommand }[] = [
  { name: 'Prepare — sort, dedup, gap-fill (merge) WS source files',   value: 'prepare' },
  { name: 'Check   — verify .csv.gz integrity; recover corrupt files', value: 'check'   },
  { name: 'Status  — read-only audit of local, remotes, and Mega',     value: 'status'  },
  { name: 'Update  — audit + sync local, remotes, and Mega',           value: 'update'  },
];

// ── Entry point ───────────────────────────────────────────────────────────────

const DEFAULT_VAULT_DIR = '/data/bitmex/vault';

export async function run(): Promise<void> {
  const choice = (await selectFromList<Subcommand>(subcommands, 'Select operation:')) ?? 'prepare';

  setDryRun(false);
  setYes(false);
  setFromDay(null);
  setLogPath(null);

  if (choice === 'status') {
    await runStatus();

    return;
  }

  if (choice === 'update') {
    await runUpdate();

    return;
  }

  const root = (await input('Path:', process.env['VAULT_DATA_DIR'] ?? DEFAULT_VAULT_DIR)) || (process.env['VAULT_DATA_DIR'] ?? DEFAULT_VAULT_DIR);

  if (choice === 'prepare') {
    await runPrepare(root);
  }

  if (choice === 'check') {
    await runCheck(root);
  }
}
