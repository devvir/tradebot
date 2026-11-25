import { describe, it, expect } from 'vitest';
import { CommanderError } from 'commander';
import { buildProgram } from '../src/program';
import { DESCRIPTION as COLD_DESCRIPTION } from '../src/commands/cold';

/** Parses `args` as the user typed them, catching what commander would exit with. */
async function run(args: string[]): Promise<{ error: CommanderError; out: string; err: string }> {
  let out = '';
  let err = '';

  const program = buildProgram()
    .exitOverride()
    .configureOutput({ writeOut: s => { out += s; }, writeErr: s => { err += s; } });

  try {
    await program.parseAsync(args, { from: 'user' });
  } catch (e) {
    if (e instanceof CommanderError) return { error: e, out, err };
    throw e;
  }

  throw new Error('expected commander to exit');
}

describe('tools program', () => {
  it('prints usage for --help and exits 0', async () => {
    const { error, out } = await run(['--help']);

    expect(error.exitCode).toBe(0);
    expect(out).toContain('Usage: tools');
    expect(out).toContain('cold');
  });

  it('says in --help how -e and -m rank against the shell and where -m looks', async () => {
    const { out } = await run(['--help']);
    const help = out.replace(/\s+/g, ' ');

    expect(help).toContain('overrides every other .env file; values the shell exported still win');
    expect(help).toContain('modules/<name>/.env, else the one modules/<group>/<name>/.env');
  });

  it('lists cold in --help with the description the menu shows', async () => {
    const { out } = await run(['--help']);

    expect(out.replace(/\s+/g, ' ')).toContain(COLD_DESCRIPTION);
  });

  it('prints the version for --version and exits 0', async () => {
    const { error, out } = await run(['--version']);

    expect(error.exitCode).toBe(0);
    expect(out.trim()).toBe('1.0.0');
  });

  it('reports an unknown command, followed by the usage', async () => {
    const { error, err } = await run(['bogus']);

    expect(error.code).toBe('commander.unknownCommand');
    expect(error.exitCode).toBe(1);
    expect(err).toContain("unknown command 'bogus'");
    expect(err).toContain('Usage: tools');
  });

  it('has no --verbose option', async () => {
    const { error } = await run(['--verbose', 'monitor']);

    expect(error.code).toBe('commander.unknownOption');
  });
});
