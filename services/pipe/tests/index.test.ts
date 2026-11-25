import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';

vi.mock('../src/service', () => ({ default: { run: vi.fn() } }));

type RunFn = (service: unknown) => Promise<void>;

/** Thrown by the mocked process.exit, so the run function stops where the real one would. */
class Exit extends Error {
  constructor(readonly code: number | undefined) { super(`exit ${code}`); }
}

const topology = { exchanges: { src: { type: 'fanout' } } };

const makeService = (broker: { declares: () => Promise<void> } | Error) => ({
  providers: {
    connect: vi.fn(async () => {
      if (broker instanceof Error) throw broker;
      return broker;
    }),
  },
  config:   vi.fn((key?: string) => (key === 'topology' ? topology : { topology })),
  logger:   { info: vi.fn(), error: vi.fn() },
  shutdown: vi.fn(async () => undefined),
});

describe('pipe entrypoint', () => {
  let run: RunFn;
  let exit: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    const SK = (await import('../src/service')).default as unknown as { run: ReturnType<typeof vi.fn> };

    await import('../src/index');

    run = SK.run.mock.calls[0]![0] as RunFn;
  });

  beforeEach(() => {
    exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Exit(code); }) as any);
  });

  afterEach(() => {
    exit.mockRestore();
  });

  it('declares the topology and shuts down', async () => {
    const broker  = { declares: vi.fn(async () => undefined) };
    const service = makeService(broker);

    await run(service);

    expect(broker.declares).toHaveBeenCalledWith(topology);
    expect(service.shutdown).toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it('exits with code 1 when a declaration fails', async () => {
    const service = makeService({ declares: vi.fn(async () => { throw new Error('PRECONDITION_FAILED'); }) });

    await expect(run(service)).rejects.toEqual(new Exit(1));

    expect(exit).toHaveBeenCalledWith(1);
    expect(service.logger.error).toHaveBeenCalled();
    expect(service.shutdown).not.toHaveBeenCalled();
  });

  it('exits with code 1 when the broker cannot be reached', async () => {
    const service = makeService(new Error('ECONNREFUSED'));

    await expect(run(service)).rejects.toEqual(new Exit(1));

    expect(exit).toHaveBeenCalledWith(1);
    expect(service.shutdown).not.toHaveBeenCalled();
  });
});
