import { onExit } from '../cleanup';
import { loadConfig } from '../config';
import { busy } from '../lock';
import { agreed, picked } from '../options';
import { check as checkBackup } from '../shared/backup';
import { Archives } from '../shared/disk';
import * as mega from '../shared/mega';
import * as record from '../shared/record';
import { againstDisk } from './checks/disk';
import { againstMega } from './checks/mega';
import { withinItself } from './checks/record';
import { info, spacer, success, warn } from '../../../shared/ui/logger';
import type { Origin } from '../types';
import type { AuditOptions, Check, Finding, Looking, Solution } from './types';

/**
 * Check that cold storage, the local disk and the record all say the same
 * thing — and offer to put right what does not.
 *
 * **Everything else in this family trusts the record.** `push` decides what to
 * send from it, `evict` what may be removed, `pull` what can come back, and
 * none of them can afford to look at the world again on every run. This is
 * where that trust is earned back: run now and then, or whenever something
 * looks off.
 *
 * **A finding is one kind of thing wrong, however often it was found**, with a
 * few of the places and what can be done about all of them. It is asked about
 * once. What is offered first is what is done where nobody is asked — unless it
 * removes something that is written down nowhere else, which is never done
 * unasked.
 *
 * **What is put right is nearly always the record.** Mega and the disk are how
 * things are; the record is what was believed, and it is brought round to them.
 *
 * A check that needs Mega is left out where Mega is not answering, and the run
 * says so: the rest is still worth knowing.
 */
export const runAudit = async (origin: Origin, options: AuditOptions = {}): Promise<void> => {
  const config = loadConfig(origin);
  const db     = record.open(config.dbPath);

  onExit(() => record.close(db));

  try {
    const reachable = await mega.available();

    if (! reachable) warn('Mega is not answering — what can be checked without it is, and nothing else');

    // Another command is at work, so its start did not look at the record's copy: an audit does, whoever else is running.
    if (reachable && busy(config.coldRoot) && ! options.dryRun) await checkBackup(config, false);

    const looking: Looking = { db, config, origin, remote: reachable ? mega : null, archives: new Archives(config.sourceRoot) };
    const findings: Finding[] = [];

    for (const [name, check] of CHECKS) {
      info(`Checking ${name}`);

      findings.push(...await check(looking));
    }

    spacer();

    if (findings.length === 0) {
      success(reachable ? 'Everything agrees' : 'Everything that could be checked agrees');

      return;
    }

    for (const finding of findings) await settle(finding, options.dryRun ?? false);
  } finally {
    record.close(db);
  }
};

// ── Internals ─────────────────────────────────────────────────────────────────

/** Every check there is, in the order they are run, each by what it says it is doing. */
const CHECKS: [string, Check][] = [
  ['the record against Mega',      againstMega],
  ['the record against the disk',  againstDisk],
  ['the record against itself',    withinItself],
];

/** Say one finding, and do about it what is chosen. */
const settle = async (finding: Finding, dryRun: boolean): Promise<void> => {
  warn(finding.problem);

  for (const example of finding.examples.slice(0, EXAMPLES)) info(`  ${example}`);

  if (finding.examples.length > EXAMPLES) info(`  … and ${(finding.examples.length - EXAMPLES).toLocaleString('en-US')} more`);
  if (finding.note) info(`  ${finding.note}`);

  const chosen = dryRun ? null : await choiceOf(finding.solutions);

  if (chosen) {
    await chosen.apply();

    success(`Done: ${chosen.label.charAt(0).toLowerCase()}${chosen.label.slice(1)}`);
  }

  spacer();
};

/**
 * Which solution to apply, or null for none. One is a yes or a no; several are
 * a list with leaving it as it is at the end. What is taken where nobody is
 * asked is the first — unless it is destructive, and then nothing.
 */
const choiceOf = async (solutions: readonly Solution[]): Promise<Solution | null> => {
  const [first] = solutions;

  if (! first) return null;

  if (solutions.length === 1) return await agreed(`${first.label}?`, ! first.destructive) ? first : null;

  return picked<Solution | null>('What should be done?', [
    ...solutions.map(one => ({ name: one.label, value: one })),
    { name: 'Leave it as it is', value: null },
  ], first.destructive ? null : first);
};

/** How many places a finding names before it says how many more there are. */
const EXAMPLES = 5;

// ── Test access ───────────────────────────────────────────────────────────────

export const _test_choiceOf = choiceOf;
