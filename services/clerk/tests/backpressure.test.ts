import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createBackpressureGate } from '../src/backpressure';
import type { RabbitMQ } from '@devvir/service-kit';

// ── Helpers ───────────────────────────────────────────────────────────────────

const makeBroker = (depthByQueue: Record<string, number>) => {
  const channel = {
    checkQueue: vi.fn(async (name: string) => ({
      messageCount: depthByQueue[name] ?? 0,
    })),
  };

  return {
    broker:  { getChannel: vi.fn(() => channel) } as unknown as RabbitMQ.Broker,
    channel,
    depths:  depthByQueue,
  };
};

// Advance the clock by one poll interval and flush resulting microtasks.
const tick = async () => {
  await vi.advanceTimersByTimeAsync(10_001);
};

// ── Resolves immediately when below limit ─────────────────────────────────────

describe('createBackpressureGate — below limit', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('resolves immediately when all queues are under the pause threshold', async () => {
    const { broker } = makeBroker({ assembler: 50_000 });
    const gate       = createBackpressureGate(broker, ['assembler'], 100_000);

    // gate() should resolve without delay
    await expect(gate()).resolves.toBeUndefined();
  });
});

// ── Pauses when over pause threshold ─────────────────────────────────────────

describe('createBackpressureGate — pause and resume', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('blocks while queue depth is above pause threshold and releases after resume threshold', async () => {
    const depths = { assembler: 115_000 };  // > 100_000 × 1.1 = 110_000
    const { broker, channel } = makeBroker(depths);
    const gate = createBackpressureGate(broker, ['assembler'], 100_000);

    // Trigger initial poll to detect the high depth
    await tick();

    let resolved = false;
    const gateCall = gate().then(() => { resolved = true; });

    // Gate should not have resolved yet
    await Promise.resolve();
    expect(resolved).toBe(false);

    // Drop depth below resume threshold (100_000 × 0.9 = 90_000)
    depths.assembler = 80_000;
    channel.checkQueue.mockResolvedValue({ messageCount: 80_000 });

    // Advance timer to trigger the next poll cycle
    await tick();
    await gateCall;

    expect(resolved).toBe(true);
  });

  it('does not block when depth is between resume and pause thresholds', async () => {
    // 105_000 > resume (90_000) but < pause (110_000) — gate should be open
    const { broker } = makeBroker({ assembler: 105_000 });
    const gate = createBackpressureGate(broker, ['assembler'], 100_000);

    await tick();

    await expect(gate()).resolves.toBeUndefined();
  });
});

// ── Multiple queues ───────────────────────────────────────────────────────────

describe('createBackpressureGate — multiple queues', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('pauses when any watched queue exceeds the threshold', async () => {
    const depths = { assembler: 50_000, registrar: 120_000 };
    const { broker } = makeBroker(depths);
    const gate = createBackpressureGate(broker, ['assembler', 'registrar'], 100_000);

    await tick();

    let resolved = false;
    const gateCall = gate().then(() => { resolved = true; });

    await Promise.resolve();
    expect(resolved).toBe(false);

    // Bring registrar below resume threshold
    depths.registrar = 85_000;
    await tick();
    await gateCall;

    expect(resolved).toBe(true);
  });

  it('stays blocked when one queue is above threshold even if others are below resume', async () => {
    // assembler is above pause threshold; registrar is below resume threshold
    // gate must remain blocked until assembler drops too
    const depths = { assembler: 120_000, registrar: 50_000 };
    const { broker } = makeBroker(depths);
    const gate = createBackpressureGate(broker, ['assembler', 'registrar'], 100_000);

    await tick();

    let resolved = false;
    const gateCall = gate().then(() => { resolved = true; });

    // Still blocked after one tick — registrar being low must not release the gate
    await tick();
    await Promise.resolve();
    expect(resolved).toBe(false);

    // Now bring assembler below resume threshold
    depths.assembler = 80_000;
    await tick();
    await gateCall;

    expect(resolved).toBe(true);
  });
});

// ── No channel ────────────────────────────────────────────────────────────────

describe('createBackpressureGate — no channel', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('resolves immediately when broker has no channel yet', async () => {
    const broker = { getChannel: vi.fn(() => null) } as unknown as RabbitMQ.Broker;
    const gate   = createBackpressureGate(broker, ['assembler'], 100_000);

    await tick();
    await expect(gate()).resolves.toBeUndefined();
  });
});
