import { describe, it, expect } from 'vitest';
import { menuArgs } from '../src/menu';

describe('menuArgs', () => {
  it('opens the menu with no arguments on a TTY', () => {
    expect(menuArgs([], true)).toEqual([]);
  });

  it('never opens the menu without a TTY', () => {
    expect(menuArgs([], false)).toBeNull();
    expect(menuArgs(['-e', 'x.env'], false)).toBeNull();
  });

  it('keeps -e and -m with their values, in every form commander reads', () => {
    expect(menuArgs(['-e', 'a.env', '--module', 'bootcamp'], true)).toEqual(['-e', 'a.env', '--module', 'bootcamp']);
    expect(menuArgs(['--env=a.env', '--module=bootcamp'], true)).toEqual(['--env=a.env', '--module=bootcamp']);
    expect(menuArgs(['-ea.env', '-mbootcamp'], true)).toEqual(['-ea.env', '-mbootcamp']);
  });

  it('leaves a value option that has no value to commander', () => {
    expect(menuArgs(['-e'], true)).toBeNull();
    expect(menuArgs(['-m', 'x', '--env'], true)).toBeNull();
  });

  it('leaves help and version to commander', () => {
    for (const flag of ['-h', '--help', '-V', '--version']) {
      expect(menuArgs([flag], true)).toBeNull();
      expect(menuArgs(['-e', 'a.env', flag], true)).toBeNull();
    }
  });

  it('leaves commands, unknown words and unknown flags to commander', () => {
    expect(menuArgs(['rabbit'], true)).toBeNull();
    expect(menuArgs(['-e', 'a.env', 'cold', 'push'], true)).toBeNull();
    expect(menuArgs(['bogus'], true)).toBeNull();
    expect(menuArgs(['--bogus'], true)).toBeNull();
    expect(menuArgs(['-v'], true)).toBeNull();
  });
});
