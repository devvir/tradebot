import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import { register as registerWs } from '../../src/commands/ws';
import { register as registerRabbit } from '../../src/commands/rabbit';
import { register as registerBouncer } from '../../src/commands/bouncer';
import { register as registerBroadcast } from '../../src/commands/broadcast';
import { register as registerRemote } from '../../src/commands/remote';
import { register as registerSynth } from '../../src/commands/synth';

function optionLongs(cmd: Command): string[] {
  return cmd.options.map(o => o.long ?? '');
}

describe('ws command', () => {
  it('registers name=ws alias=websocket', () => {
    const program = new Command();
    registerWs(program);
    const cmd = program.commands.find(c => c.name() === 'ws');
    expect(cmd).toBeDefined();
    expect(cmd!.aliases()).toContain('websocket');
  });

  it('has --testnet and --guest options', () => {
    const program = new Command();
    registerWs(program);
    const longs = optionLongs(program.commands.find(c => c.name() === 'ws')!);
    expect(longs).toContain('--testnet');
    expect(longs).toContain('--guest');
  });
});

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

describe('bouncer command', () => {
  it('registers name=bouncer', () => {
    const program = new Command();
    registerBouncer(program);
    expect(program.commands.find(c => c.name() === 'bouncer')).toBeDefined();
  });

  it('has --all and --account options', () => {
    const program = new Command();
    registerBouncer(program);
    const longs = optionLongs(program.commands.find(c => c.name() === 'bouncer')!);
    expect(longs).toContain('--all');
    expect(longs).toContain('--account');
  });
});

describe('broadcast command', () => {
  it('registers name=broadcast', () => {
    const program = new Command();
    registerBroadcast(program);
    expect(program.commands.find(c => c.name() === 'broadcast')).toBeDefined();
  });

  it('has --type option but NOT --watch (removed)', () => {
    const program = new Command();
    registerBroadcast(program);
    const longs = optionLongs(program.commands.find(c => c.name() === 'broadcast')!);
    expect(longs).toContain('--type');
    expect(longs).not.toContain('--watch');
  });
});

describe('remote command', () => {
  it('registers name=remote', () => {
    const program = new Command();
    registerRemote(program);
    expect(program.commands.find(c => c.name() === 'remote')).toBeDefined();
  });

  it('has sync-env and pull subcommands', () => {
    const program = new Command();
    registerRemote(program);
    const remote = program.commands.find(c => c.name() === 'remote')!;
    const subNames = remote.commands.map(c => c.name());
    expect(subNames).toContain('sync-env');
    expect(subNames).toContain('pull');
  });

  it('has no options on the top-level remote command', () => {
    const program = new Command();
    registerRemote(program);
    const remote = program.commands.find(c => c.name() === 'remote')!;
    expect(optionLongs(remote)).toHaveLength(0);
  });
});

/**
 * `synth` lost `levels` and `stage1` with MongoDB. `calibrate` shells out to a
 * Python app that only ever touched files, so it stays — and the bare command
 * runs it, there being nothing left to choose between.
 */
describe('synth command', () => {
  it('registers name=synth', () => {
    const program = new Command();
    registerSynth(program);
    expect(program.commands.find(c => c.name() === 'synth')).toBeDefined();
  });

  it('exposes calibrate and nothing that needed a database', () => {
    const program = new Command();
    registerSynth(program);
    const synth = program.commands.find(c => c.name() === 'synth')!;
    const subNames = synth.commands.map(c => c.name());
    expect(subNames).toEqual(['calibrate']);
  });
});
