import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import { register as registerRabbit } from '../../src/commands/rabbit';
import { register as registerRemote } from '../../src/commands/remote';

function optionLongs(cmd: Command): string[] {
  return cmd.options.map(o => o.long ?? '');
}

describe('rabbit command', () => {
  it('registers name=rabbit alias=amqp', () => {
    const program = new Command();
    registerRabbit(program);
    const cmd = program.commands.find(c => c.name() === 'rabbit');
    expect(cmd).toBeDefined();
    expect(cmd!.aliases()).toContain('amqp');
  });

  it('has --list, --watch, --messages options', () => {
    const program = new Command();
    registerRabbit(program);
    const longs = optionLongs(program.commands.find(c => c.name() === 'rabbit')!);
    expect(longs).toContain('--list');
    expect(longs).toContain('--watch');
    expect(longs).toContain('--messages');
  });
});

describe('remote command', () => {
  it('registers name=remote', () => {
    const program = new Command();
    registerRemote(program);
    expect(program.commands.find(c => c.name() === 'remote')).toBeDefined();
  });

  it('has sync-env as its one subcommand', () => {
    const program = new Command();
    registerRemote(program);
    const remote = program.commands.find(c => c.name() === 'remote')!;
    const subNames = remote.commands.map(c => c.name());
    expect(subNames).toEqual(['sync-env']);
  });

  it('has no options on the top-level remote command', () => {
    const program = new Command();
    registerRemote(program);
    const remote = program.commands.find(c => c.name() === 'remote')!;
    expect(optionLongs(remote)).toHaveLength(0);
  });
});
