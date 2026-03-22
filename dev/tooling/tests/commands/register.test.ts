import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import { register as registerWs } from '../../src/commands/ws.js';
import { register as registerDb } from '../../src/commands/db.js';
import { register as registerRabbit } from '../../src/commands/rabbit.js';
import { register as registerBouncer } from '../../src/commands/bouncer.js';
import { register as registerBroadcast } from '../../src/commands/broadcast.js';
import { register as registerSignal } from '../../src/commands/signal.js';

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

describe('db command', () => {
  it('registers name=db alias=database', () => {
    const program = new Command();
    registerDb(program);
    const cmd = program.commands.find(c => c.name() === 'db');
    expect(cmd).toBeDefined();
    expect(cmd!.aliases()).toContain('database');
  });

  it('has --collection and --list options', () => {
    const program = new Command();
    registerDb(program);
    const longs = optionLongs(program.commands.find(c => c.name() === 'db')!);
    expect(longs).toContain('--collection');
    expect(longs).toContain('--list');
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

describe('signal command', () => {
  it('registers name=signal', () => {
    const program = new Command();
    registerSignal(program);
    expect(program.commands.find(c => c.name() === 'signal')).toBeDefined();
  });

  it('has --latest and --symbol options', () => {
    const program = new Command();
    registerSignal(program);
    const longs = optionLongs(program.commands.find(c => c.name() === 'signal')!);
    expect(longs).toContain('--latest');
    expect(longs).toContain('--symbol');
  });
});
