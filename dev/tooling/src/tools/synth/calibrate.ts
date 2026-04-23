import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

/** Resolved at runtime from compiled output location (dist/tools/synth/ → repo root). */
const REPO_ROOT = path.resolve(__dirname, '../../../../../');
const SCRIPT = path.join(REPO_ROOT, 'scripts/calibrate/main.py');
const VENV_DIR = path.join(REPO_ROOT, 'scripts/calibrate/.venv');
const PYTHON = path.join(VENV_DIR, 'bin/python');
const REQUIREMENTS = path.join(REPO_ROOT, 'scripts/calibrate/requirements.txt');

export async function runCalibrate(args: string[]): Promise<void> {
  ensureVenv();

  await new Promise<void>((resolve, reject) => {
    const child = spawn(PYTHON, [SCRIPT, ...args], { stdio: 'inherit' });

    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Calibration script exited with code ${code ?? '?'}`));
      } else {
        resolve();
      }
    });

    child.on('error', reject);
  });
}

function ensureVenv(): void {
  if (! existsSync(VENV_DIR)) {
    const result = spawnSync('python3', ['-m', 'venv', VENV_DIR], { stdio: 'inherit' });

    if (result.status !== 0) {
      throw new Error('Failed to create Python venv');
    }
  }

  const result = spawnSync(
    PYTHON,
    ['-m', 'pip', 'install', '-q', '-r', REQUIREMENTS],
    { stdio: 'inherit' },
  );

  if (result.status !== 0) {
    throw new Error('Failed to install Python dependencies');
  }
}
