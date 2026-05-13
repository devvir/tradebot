import { describe, it, expect, vi, afterEach } from 'vitest';
import { computeHoles } from '../../../../src/tools/sources/status/holes';
import type { TableState } from '../../../../src/tools/sources/scan/types';

// ── Helpers ───────────────────────────────────────────────────────────────────

function wsTable(name = 'orderBookL2'): TableState {
  return { name, origin: 'ws', days: new Map(), megaTars: [] };
}

function restTable(name = 'settlement'): TableState {
  return { name, origin: 'rest', days: new Map(), megaTars: [] };
}

afterEach(() => vi.restoreAllMocks());

// ── WS Tardis rule ────────────────────────────────────────────────────────────

describe('computeHoles — WS Tardis rule', () => {
  it('fills non-01 days before WS_BUCKETING_START', async () => {
    // 2026-01-05 is before 2026-03-08 and not the 01st
    const result = await computeHoles('orderBookL2', wsTable(), '20260105', '20260105');

    expect(result.filled.has('20260105')).toBe(true);
  });

  it('does not fill the 01st of a month before WS_BUCKETING_START', async () => {
    const result = await computeHoles('orderBookL2', wsTable(), '20260101', '20260101');

    expect(result.filled.has('20260101')).toBe(false);
  });

  it('does not fill any day on or after WS_BUCKETING_START', async () => {
    // 2026-03-10 is after WS_BUCKETING_START (2026-03-08)
    const result = await computeHoles('orderBookL2', wsTable(), '20260310', '20260310');

    expect(result.filled.has('20260310')).toBe(false);
  });

  it('does not apply to REST tables', async () => {
    const result = await computeHoles('compositeIndex', restTable('compositeIndex'), '20260105', '20260105');

    expect(result.filled.has('20260105')).toBe(false);
    expect(result.notes).toHaveLength(0);
  });

  it('emits a caption when at least one WS day was filled', async () => {
    const result = await computeHoles('orderBookL2', wsTable(), '20260101', '20260107');

    expect(result.notes.some(n => n.includes('Tardis'))).toBe(true);
  });

  it('emits no caption when no day was filled (all on or after WS_BUCKETING_START)', async () => {
    const result = await computeHoles('orderBookL2', wsTable(), '20260401', '20260410');

    expect(result.notes).toHaveLength(0);
  });

  it('fills span of days across month boundary', async () => {
    // Jan 2026: only day 01 is real; 02–31 are filled holes
    const result = await computeHoles('orderBookL2', wsTable(), '20260101', '20260201');

    const filled = result.filled;

    expect(filled.has('20260101')).toBe(false);  // day 01 — real
    expect(filled.has('20260115')).toBe(true);   // mid-month — filled
    expect(filled.has('20260201')).toBe(false);  // day 01 of Feb — real
    expect(filled.has('20260215')).toBe(false);  // after WS_BUCKETING_START boundary? no — Feb 15 < 20260308
  });
});

// ── Settlement async rule ─────────────────────────────────────────────────────

describe('computeHoles — settlement rule', () => {
  it('fills non-settlement days when API returns settlement dates', async () => {
    // Mock fetch: only 2026-01-08 is a settlement day
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok:   true,
      json: async () => [{ timestamp: '2026-01-08T12:00:00.000Z' }],
    }));

    const result = await computeHoles('settlement', restTable(), '20260101', '20260110');

    expect(result.filled.has('20260108')).toBe(false);  // settlement day — not filled
    expect(result.filled.has('20260101')).toBe(true);   // non-settlement — filled
    expect(result.filled.has('20260110')).toBe(true);   // non-settlement — filled
    expect(result.notes.some(n => n.toLowerCase().includes('settlement'))).toBe(true);
  });

  it('adds a fail caption and fills nothing when fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network error')));

    const result = await computeHoles('settlement', restTable(), '20260101', '20260110');

    expect(result.filled.size).toBe(0);
    expect(result.notes.some(n => n.includes('Failed to fetch'))).toBe(true);
  });

  it('does not apply to non-settlement tables', async () => {
    const fetchSpy = vi.fn();

    vi.stubGlobal('fetch', fetchSpy);

    await computeHoles('funding', restTable('funding'), '20260101', '20260110');

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('clamps the effective start to SETTLEMENT_API_START', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok:   true,
      json: async () => [],
    }));

    // fromDay before SETTLEMENT_API_START (2026-01-01) — should still succeed, just empty fills
    const result = await computeHoles('settlement', restTable(), '20250101', '20250131');

    expect(result.filled.size).toBe(0);  // before API start, nothing fetched
    expect(result.notes).toHaveLength(0);
  });
});

// ── No applicable rule ────────────────────────────────────────────────────────

describe('computeHoles — no rule applies', () => {
  it('returns empty filled set and no notes for REST non-settlement table', async () => {
    const result = await computeHoles('funding', restTable('funding'), '20260101', '20260110');

    expect(result.filled.size).toBe(0);
    expect(result.notes).toHaveLength(0);
  });

  it('returns empty filled set when fromDay > toDay', async () => {
    const result = await computeHoles('orderBookL2', wsTable(), '20260110', '20260101');

    expect(result.filled.size).toBe(0);
    expect(result.notes).toHaveLength(0);
  });
});
