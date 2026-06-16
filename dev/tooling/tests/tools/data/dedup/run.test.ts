import { describe, it, expect } from 'vitest';
import { _test_isDedupCandidate as isDedupCandidate } from '../../../../src/tools/data/dedup/run';

// ── Helpers ──────────────────────────────────────────────────────────────────

const noneExist = () => false;
const allExist  = () => true;

// ── isDedupCandidate ──────────────────────────────────────────────────────────

describe('isDedupCandidate', () => {
  it('accepts a dedup-eligible source with no existing output', () => {
    expect(isDedupCandidate('/v/instrument/2026/20260408.local.csv.gz', noneExist)).toBe(true);
    expect(isDedupCandidate('/v/orderBookL2/2026/20260408.local.csv.gz', noneExist)).toBe(true);
  });

  it('rejects tables outside the dedup set', () => {
    expect(isDedupCandidate('/v/quote/2026/20260408.local.csv.gz', noneExist)).toBe(false);
    expect(isDedupCandidate('/v/trade/2026/20260408.local.csv.gz', noneExist)).toBe(false);
  });

  it('rejects an already-deduped output file', () => {
    expect(isDedupCandidate('/v/instrument/2026/20260408.local.dedup.csv.gz', noneExist)).toBe(false);
  });

  it('rejects a source whose .dedup output already exists', () => {
    const exists = (p: string) => p === '/v/instrument/2026/20260408.local.dedup.csv.gz';

    expect(isDedupCandidate('/v/instrument/2026/20260408.local.csv.gz', exists)).toBe(false);
  });

  it('rejects everything when all outputs already exist', () => {
    expect(isDedupCandidate('/v/instrument/2026/20260408.local.csv.gz', allExist)).toBe(false);
  });

  it('accepts a bare bucket (sources and buckets are both eligible)', () => {
    expect(isDedupCandidate('/v/instrument/2026/20260408.csv.gz', noneExist)).toBe(true);
  });
});
