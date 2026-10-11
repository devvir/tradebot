import { afterEach, describe, expect, it, vi } from 'vitest';
import { onExit } from '../../../src/tools/cold/cleanup';

vi.mock('../../../src/shared/ui/logger', () => ({ info: vi.fn() }));

/**
 * A Ctrl-C reaches a cold command twice — from the terminal, and again from
 * `tools`, which forwards it — and what the run holds has to come back either way.
 */
describe('a stop signal', () => {
  afterEach(() => vi.restoreAllMocks());

  it('is still listened to after the first, and gives everything back once', () => {
    const exit  = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const given = vi.fn();

    onExit(given);

    // The handler is the last SIGINT listener added; it is called here rather than raised, so the test runner's own are left alone.
    const stop = process.listeners('SIGINT').at(-1) as () => void;

    stop();
    stop();

    expect(process.listeners('SIGINT')).toContain(stop);
    expect(given).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(130);

    process.removeListener('SIGINT', stop);
    write.mockRestore();
  });
});
